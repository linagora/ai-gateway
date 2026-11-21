"""Mesure l'écart entre les vecteurs de qwen3-embedding-8b, servi par OVHcloud, et ceux de qwen3-embedding-8b-scaleway,
le même modèle servi par Scaleway (ticket #212). Le script rend des chiffres, sans verdict : l'admin décide si la
bascule de qwen3-embedding-8b chez Scaleway garde les index construits chez OVHcloud, ou s'il faudra revectoriser.

Dix textes rédigés pour la mesure, sans donnée confidentielle, sont envoyés en une requête à chaque modèle, au format
base64 que demandent par défaut les SDK OpenAI : par langue, français et anglais, deux courts, deux longs (300 mots
environ) et un très long (un journal de 400 jours). Le script rend l'hôte que LiteLLM a appelé pour chaque modèle
(en-tête x-litellm-model-api-base), la similarité cosinus de chaque paire de vecteurs (le même texte, d'un modèle à
l'autre), puis leur minimum et leur moyenne. Chaque modèle reçoit les textes une seconde fois : la similarité de ses
deux passages donne le bruit de calcul de son hébergeur, auquel comparer l'écart entre les deux modèles.

Appels faits avec la clé maître, comme la supervision : aucune dépense sur une clé de collaborateur (un centime
environ). Exécuté DANS le conteneur litellm (la clé maître y est déjà en variable d'environnement, jamais affichée) :

  cd /opt/linagora-ia && docker compose exec -T litellm python3 - < scripts/mesurer-vecteurs.py

Code de sortie : 0 si chaque modèle rend, à ses deux passages, un vecteur base64 par texte, tous de la même taille ; 1
sinon.
"""
import base64
import collections
import json
import math
import os
import struct
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = "http://localhost:4000/admin"
USAGE = "usage : docker compose exec -T litellm python3 - < scripts/mesurer-vecteurs.py"
MODELES = ("qwen3-embedding-8b", "qwen3-embedding-8b-scaleway")  # servis par OVHcloud, puis par Scaleway
Passage = collections.namedtuple("Passage", "vecteurs jetons hote")


def journal(gabarit, *listes, jours=400):
    """Très long texte sans redite : un journal fictif, une entrée par jour, dont les éléments tournent dans des listes
    de 3, 7, 5 et 11 éléments, premiers entre eux, sans repasser par la même combinaison. Il montre si l'écart entre les
    deux hébergeurs grandit avec la longueur du texte, ou si l'un le tronque."""
    entrees = (gabarit.format(jour, *(liste[jour % len(liste)] for liste in listes)) for jour in range(1, jours + 1))
    return "\n".join(entrees)


# Textes rédigés pour la mesure : ni contenu de collaborateur, ni donnée interne.
TEXTES = {
    "fr-court-affirmation": "Le train de 8 h 12 pour Lyon partira avec vingt minutes de retard à la suite d'un incident technique.",
    "fr-court-question": "Comment partager un agenda avec toute mon équipe sans donner accès à mes rendez-vous privés ?",
    "fr-long-recit": (
        "Chaque samedi, dès six heures, la place de l'église change de visage. Les premiers camions arrivent dans la "
        "pénombre, se garent le long du lavoir, et les marchands déplient leurs tréteaux avec des gestes répétés depuis "
        "des années. Le maraîcher installe ses cagettes de poireaux et de pommes de terre, encore couvertes de terre, à "
        "côté des bottes de radis qu'il a liées la veille. En face, la fromagère dispose ses tommes sur un lit de paille et "
        "affiche à la craie le prix du comté de dix-huit mois. Un peu plus loin, un apiculteur aligne ses pots de miel du "
        "plus clair au plus sombre, de l'acacia au châtaignier, pour que les clients voient d'un regard ce qui les distingue.\n\n"
        "Vers huit heures, les habitués font leur tour. Certains viennent avec un cabas et une liste précise, d'autres sans "
        "idée arrêtée, pour le plaisir de discuter. On commente la pluie de la semaine, la hauteur de la rivière, le prix du "
        "gazole et la fermeture annoncée de la boulangerie de la rue haute. Les enfants réclament une crêpe au stand du fond, "
        "où une plaque fume déjà. Le boucher, qui connaît chaque famille, met de côté sans qu'on le lui demande le rôti du "
        "dimanche des voisins âgés.\n\n"
        "À dix heures, la foule est à son comble. Les allées se resserrent, les poussettes avancent au pas, et l'on entend "
        "des accents venus d'ailleurs : des touristes de passage, des saisonniers, une famille installée depuis peu qui "
        "découvre le marché. Le maire fait un passage, serre quelques mains, écoute une plainte sur le stationnement et "
        "promet d'en reparler au conseil.\n\n"
        "Puis, vers midi et demi, le mouvement s'inverse. Les marchands rabattent les bâches, rangent les invendus dans des "
        "caisses, échangent entre eux un fromage contre une salade. Le balayeur municipal attend que la place se vide pour "
        "passer la machine. À treize heures, il ne reste qu'une odeur de crêpe et quelques feuilles de chou sur les pavés "
        "mouillés. La place redevient un parking ordinaire, jusqu'au samedi suivant."
    ),
    "fr-long-procedure": (
        "Pour préparer une formation d'une journée destinée à une dizaine de participants, commencez par fixer l'objectif en "
        "une phrase : ce que chacun saura faire en repartant, et non la liste des sujets abordés. Cet objectif guide tous les "
        "choix suivants, du découpage de la journée aux exercices proposés.\n\n"
        "Recueillez ensuite les attentes. Un court questionnaire envoyé deux semaines avant suffit : niveau de départ, "
        "situations concrètes rencontrées, contraintes d'horaire ou d'accessibilité. Les réponses permettent d'ajuster le "
        "contenu et de repérer les participants qui auront besoin d'un accompagnement particulier.\n\n"
        "Construisez le déroulé par séquences de quarante-cinq minutes au plus, chacune avec un apport bref, une mise en "
        "pratique et un temps d'échange. Prévoyez une pause le matin, une l'après-midi, et ne placez pas l'exercice le plus "
        "exigeant juste après le déjeuner. Gardez une marge d'un quart d'heure par demi-journée : les questions prennent "
        "toujours plus de temps que prévu.\n\n"
        "Préparez le matériel la veille. Vérifiez que la salle dispose d'un écran, de prises en nombre suffisant et d'un "
        "accès au réseau, puis testez la projection avec votre propre ordinateur. Imprimez les consignes des exercices : un "
        "support papier évite que chacun cherche le bon fichier pendant que le temps passe. Si certains participants suivent "
        "à distance, faites un essai du son et de l'image avec un collègue.\n\n"
        "Le jour même, arrivez une demi-heure en avance. Rappelez l'objectif en ouverture, puis demandez à chacun ce qu'il "
        "attend de la journée, en une phrase. Notez ces attentes au tableau et revenez-y en fin de journée pour vérifier "
        "qu'elles ont trouvé une réponse.\n\n"
        "Enfin, terminez par une évaluation courte, à chaud, et envoyez quelques jours plus tard un récapitulatif : les points "
        "clés, les ressources citées et un contact pour les questions qui viendront avec la pratique."
    ),
    "fr-tres-long-journal": journal(
        "Jour {} : {} a reçu {} {} et a noté {}.",
        ("l'équipe du matin", "l'équipe de l'après-midi", "l'équipe de nuit"),
        ("douze palettes de carreaux", "quarante caisses de vis", "six rouleaux de câble", "vingt sacs de ciment",
         "huit lots de planches", "quinze bidons de peinture", "trente cartons de joints"),
        ("au quai nord", "au quai sud", "dans l'entrepôt B", "devant l'atelier de découpe", "dans la cour de livraison"),
        ("deux emballages abîmés", "un retard du transporteur", "une erreur sur le bon de livraison", "aucune anomalie",
         "une étiquette illisible", "trois unités manquantes", "un chariot à réparer", "une porte de quai bloquée",
         "un colis livré en trop", "une palette mal filmée", "un contrôle de sécurité réussi"),
    ),
    "en-short-statement": "The library will close at noon on Friday while the heating system is being repaired.",
    "en-short-question": "How do I export my contacts to a file that another email client can import?",
    "en-long-narrative": (
        "The community garden sits on a narrow strip of land between the railway and a row of brick houses. Ten years ago "
        "it was a car park that nobody used; today it holds forty raised beds, a tool shed painted bright green, and a "
        "compost corner that the volunteers defend with surprising passion.\n\n"
        "On weekday evenings the garden belongs to people coming home from work. They water quickly, pull a few weeds, and "
        "leave with a handful of herbs for dinner. Weekends are different. On Saturday mornings the gate stays open and the "
        "garden fills with families, retired neighbours and students from the college across the road. Someone always "
        "brings a flask of coffee; someone else always forgets the key to the shed.\n\n"
        "Each bed is looked after by a household, but the rules encourage sharing. A notice board by the gate lists who "
        "needs help and who has seedlings to spare. In spring, tomato plants change hands by the dozen. In late summer, the "
        "surplus is so large that a table by the entrance offers courgettes to anyone walking past, with a handwritten sign "
        "asking only that they bring back the empty basket.\n\n"
        "Not everything goes smoothly. One year, slugs destroyed almost every lettuce in a single wet week. Another year, a "
        "dry summer forced the group to install a rainwater tank and agree on a watering rota, which took three meetings and "
        "several heated emails. The tank now collects water from the roof of the shed, and the rota has become a tradition "
        "that nobody dares to question.\n\n"
        "The garden has also changed the street. Neighbours who had lived side by side for years without speaking now know "
        "each other's names. Children who had never seen a carrot pulled from the ground now argue about the best way to "
        "grow strawberries. In winter, when there is little to do outside, the volunteers meet in the café at the corner to "
        "plan the next season, sketching new beds on paper napkins."
    ),
    "en-long-procedure": (
        "To set up reliable backups for a small office, start by listing what actually needs to be protected: shared "
        "documents, accounting files, email archives, and the configuration of any server or network device. For each item, "
        "note who owns it, how often it changes and how long the office could work without it. These answers decide how "
        "often each backup runs and how quickly a restore must be possible.\n\n"
        "Follow the three-two-one rule: keep three copies of the data, on two different kinds of storage, with one copy away "
        "from the office. A common arrangement is the working copy on the file server, a nightly copy on a separate disk in "
        "the office, and a weekly copy sent to an external storage provider.\n\n"
        "Automate the backups rather than relying on someone to remember them. Schedule the nightly job outside working "
        "hours, and make it send a short report after each run, with the number of files copied and any errors. Ask two "
        "people to read these reports, so that a failure is noticed even during the holidays.\n\n"
        "Encrypt every copy that leaves the office, and store the encryption key apart from the backups themselves. A backup "
        "that cannot be decrypted is as useless as no backup at all, so write down where the key is kept and who can "
        "retrieve it.\n\n"
        "Most importantly, test the restores. Once a month, pick a few files at random and restore them to a separate "
        "folder; once a year, try to rebuild a complete machine from the backups alone. Time each test and record the "
        "result. The first test usually reveals a missing folder, an expired password or a step that only one person knew.\n\n"
        "Finally, review the plan whenever the office changes: a new application, a new kind of sensitive file, or a move to "
        "new premises. A backup plan that matches last year's office will fail at the worst possible moment."
    ),
    "en-very-long-log": journal(
        "Day {}: {} received {} {} and noted {}.",
        ("the morning shift", "the afternoon shift", "the night shift"),
        ("twelve pallets of tiles", "forty boxes of screws", "six reels of cable", "twenty bags of cement",
         "eight bundles of planks", "fifteen tins of paint", "thirty cartons of seals"),
        ("at the north dock", "at the south dock", "in warehouse B", "outside the cutting workshop", "in the delivery yard"),
        ("two damaged packages", "a late carrier", "an error on the delivery note", "no issue", "an unreadable label",
         "three missing units", "a trolley to repair", "a stuck dock door", "one parcel too many",
         "a badly wrapped pallet", "a passed safety check"),
    ),
}


def decoder(valeur):
    """Vecteur d'une chaîne base64 de nombres flottants sur 4 octets, petit-boutistes (format des SDK OpenAI)."""
    brut = base64.b64decode(valeur)
    return struct.unpack(f"<{len(brut) // 4}f", brut)


def demander(modele):
    """Un passage des TEXTES par le modèle : leurs vecteurs dans l'ordre, les jetons comptés et l'hôte que LiteLLM a
    appelé ; sort en erreur sans un vecteur base64 par texte."""
    corps = {"model": modele, "input": list(TEXTES.values()), "encoding_format": "base64"}
    req = urllib.request.Request(BASE + "/v1/embeddings", data=json.dumps(corps).encode(), method="POST",
                                 headers={"Authorization": "Bearer " + os.environ["LITELLM_MASTER_KEY"],
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            reponse = json.loads(r.read())
            api_base = r.headers.get("x-litellm-model-api-base")
    except urllib.error.HTTPError as e:
        raise SystemExit(f"✘ {modele} : HTTP {e.code} {e.read()[:300]!r}")
    except urllib.error.URLError as e:
        raise SystemExit(f"✘ {modele} : LiteLLM injoignable ({e.reason})")
    donnees = sorted(reponse.get("data") or [], key=lambda d: d.get("index", 0))
    if len(donnees) != len(TEXTES):
        raise SystemExit(f"✘ {modele} : {len(donnees)} vecteurs pour {len(TEXTES)} textes")
    if not all(isinstance(d.get("embedding"), str) for d in donnees):
        raise SystemExit(f"✘ {modele} : vecteurs rendus en nombres, et non en base64 comme demandé")
    return Passage(vecteurs=[decoder(d["embedding"]) for d in donnees],
                   jetons=(reponse.get("usage") or {}).get("prompt_tokens"),
                   hote=urllib.parse.urlsplit(api_base).hostname if api_base else None)


def cosinus(a, b):
    return sum(x * y for x, y in zip(a, b)) / (math.hypot(*a) * math.hypot(*b))


def six_decimales(x):
    return f"{x:.6f}".replace(".", ",")


def minimum_et_moyenne(similarites):
    return f"minimum {six_decimales(min(similarites))}, moyenne {six_decimales(sum(similarites) / len(similarites))}"


def afficher(passages, taille):
    ovh, scaleway = MODELES
    print(f"• {ovh} face à {scaleway} : {len(TEXTES)} textes, vecteurs de {taille} nombres, demandés en base64 comme les "
          "SDK OpenAI")
    for modele, paire in passages.items():
        hotes = ", ".join(sorted({p.hote or "non indiqué" for p in paire}))
        print(f"  {modele} : hôte {hotes}, {paire[0].jetons} jetons comptés")
    croisees = [cosinus(x, y) for x, y in zip(passages[ovh][0].vecteurs, passages[scaleway][0].vecteurs)]
    for (nom, texte), similarite in zip(TEXTES.items(), croisees):
        print(f"  {nom} ({len(texte.split())} mots) : {six_decimales(similarite)}")
    print(f"  d'un modèle à l'autre : {minimum_et_moyenne(croisees)}")
    print("• bruit de chaque modèle (les mêmes textes, deux passages) :")
    for modele, (premier, second) in passages.items():
        print(f"  {modele} : {minimum_et_moyenne([cosinus(x, y) for x, y in zip(premier.vecteurs, second.vecteurs)])}")


def main():
    if len(sys.argv) > 1:
        raise SystemExit(USAGE)
    passages = {modele: (demander(modele), demander(modele)) for modele in MODELES}
    tailles = {len(v) for paire in passages.values() for passage in paire for v in passage.vecteurs}
    if len(tailles) != 1:
        raise SystemExit(f"✘ vecteurs de tailles différentes ({', '.join(map(str, sorted(tailles)))}) : ils ne se "
                         "comparent pas")
    afficher(passages, tailles.pop())


main()
