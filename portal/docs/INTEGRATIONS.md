# Kit d'intégration du portail AI Gateway

Ce guide s'adresse aux équipes qui veulent qu'une application (une **intégration**) agisse pour les collaborateurs de
LINAGORA dans le portail AI Gateway : demander une clé d'API, rejoindre une équipe, suivre ses demandes et ses clés.
Il décrit le mécanisme, ce qu'il faut fournir, la signature des jetons, les parcours, les erreurs, le développement
contre l'environnement de dev, puis la mise en service, la rotation des clés et la coupure.

Le contrat se consulte et s'essaie dans le portail, avec Swagger UI, pour tout collaborateur connecté :
<https://ai-gateway.linagora.com/documentation/api>. Pour essayer une route, cliquez sur « Authorize » et collez un jeton
signé par votre intégration (section 4) : l'appel part de votre navigateur et passe les mêmes contrôles que ceux de
l'intégration, adresse IP comprise.

Le contrat de référence est le document OpenAPI 3.1 de l'API, servi par le portail à toute intégration authentifiée qui a
le périmètre `lecture` :
`GET https://ai-gateway.linagora.com/api/v1/openapi.json` (en dev : `http://127.0.0.1:54600/api/v1/openapi.json`). Sa
source est dans le dépôt : `portal/src/lib/integrations/openapi-v1.json`.

## 1. Principes

- **Intégration** : une application tierce, déclarée par un admin du portail dans l'onglet « Intégrations » de la
  gestion. Son identifiant (par exemple `team-manager`) est immuable.
- **Collaborateur** : la personne pour qui l'intégration agit, désignée par son uid LDAP. L'intégration agit pour un
  seul collaborateur à la fois, sur ses propres demandes et clés, **jamais** avec les droits d'un admin ou d'un
  responsable d'équipe, même si le collaborateur l'est dans le portail. Les demandes restent examinées et validées dans
  le portail, par les mêmes personnes, avec les mêmes règles et les mêmes courriels.
- **Jeton d'intégration** : chaque appel porte un JWT de cinq minutes au plus, **signé par l'intégration** avec sa clé
  privée. Le portail le vérifie avec la clé publique que l'admin a enregistrée : aucun secret n'est partagé, et le
  portail ne peut pas fabriquer de jeton.
- **Périmètres** : ce que l'admin autorise l'intégration à faire.
  - `lecture` : équipes, catalogue, demandes et clés du collaborateur, et le contrat de l'API ;
  - `demandes` : demander une clé ou l'accès à une équipe, compléter et annuler une demande ;
  - `cles` : retirer, remplacer et révoquer une clé, préparer son renouvellement (seconde livraison, ouverte par un
    admin après sa recette, section 8).
- **Canal** : chaque action faite par l'API est inscrite au journal d'audit du portail avec l'identifiant de
  l'intégration, qui la distingue des actions faites dans le portail.

Chaque appel passe ces contrôles, dans cet ordre : jeton valide (sinon 401), intégration active (sinon 503), adresse IP
de l'appelant dans la liste de l'intégration (sinon 403), plafond de requêtes (sinon 429), route dans le périmètre
(sinon 403). Au premier appel pour un collaborateur, le portail l'enregistre auprès de la passerelle, comme à sa
première connexion au portail.

## 2. Ce qu'une intégration fournit pour être déclarée

À envoyer aux admins du portail :

| Élément | Précisions |
|---|---|
| Identifiant | De 2 à 40 caractères : minuscules, chiffres et tirets entre deux caractères (`team-manager`). Il sert d'émetteur (`iss`) aux jetons et de canal au journal d'audit ; il ne change jamais. |
| Nom | Tel qu'il apparaîtra dans la gestion et dans les courriels aux admins. |
| Clé publique | Au format PEM (`-----BEGIN PUBLIC KEY-----`), Ed25519 de préférence (algorithme `EdDSA`), RSA de 2 048 bits au moins sinon (`RS256`), avec son identifiant de clé (`kid`, de 1 à 64 lettres, chiffres, points, tirets ou soulignés) et son empreinte (section 3). **Jamais la clé privée.** |
| Adresses IP de sortie | Adresses ou plages CIDR (IPv4 ou IPv6) d'où l'intégration appelle l'API ; tout autre appel est refusé. |
| Périmètre demandé | `lecture`, `demandes`, puis `cles` après la recette de la seconde livraison. |
| Plafond | Requêtes par minute, tous collaborateurs confondus ; 120 par défaut. |
| Identité des collaborateurs | Confirmation que le `sub` des jetons est l'uid LDAP, exactement celui que LemonLDAP::NG donne au portail. |

## 3. Créer la paire de clés

Avec OpenSSL 3 :

```bash
openssl genpkey -algorithm ed25519 -out cle-privee.pem          # à garder secrète, chez l'intégration seulement
openssl pkey -in cle-privee.pem -pubout -out cle-publique.pem   # à transmettre aux admins
chmod 600 cle-privee.pem
```

Empreinte de la clé publique, que l'onglet « Intégrations » et les courriels aux admins affichent sous la forme
`SHA256:…` ; les admins la comparent à celle que vous leur donnez :

```bash
openssl pkey -pubin -in cle-publique.pem -outform DER | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '='
```

À défaut d'Ed25519 : `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out cle-privee.pem`, et
l'algorithme `RS256`.

## 4. Le jeton d'intégration

Un JWT (compact, trois parties en base64url) :

- en-tête : `alg` est l'algorithme de la clé enregistrée (`EdDSA` ou `RS256`, aucun autre, jamais `none`), `kid`
  l'identifiant de cette clé ;
- revendications :
  - `iss` : l'identifiant de l'intégration ;
  - `aud` : `ai-gateway` ;
  - `sub` : l'uid LDAP du collaborateur ;
  - `email` et `name` : son adresse et son nom affiché ;
  - `iat` et `exp` : `exp` au plus 300 secondes après `iat`, les deux calculés au même instant ; le portail tolère
    trente secondes d'écart d'horloge.

Signez un jeton par appel, ou réutilisez-le pendant sa courte validité. Il s'envoie dans l'en-tête
`Authorization: Bearer <jeton>`. Les exemples ci-dessous lisent la clé privée dans `cle-privee.pem`.

### TypeScript (Node.js, bibliothèque `jose`)

```ts
import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

const PORTAIL = "https://ai-gateway.linagora.com/api/v1";
const cle = await importPKCS8(readFileSync("cle-privee.pem", "utf8"), "EdDSA");

/** Jeton de cinq minutes au plus : iat et exp calculés au même instant. */
async function jeton(collaborateur: { uid: string; email: string; name: string }): Promise<string> {
  const maintenant = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: collaborateur.email, name: collaborateur.name })
    .setProtectedHeader({ alg: "EdDSA", kid: "team-manager-2026-09" })
    .setIssuer("team-manager")
    .setAudience("ai-gateway")
    .setSubject(collaborateur.uid)
    .setIssuedAt(maintenant)
    .setExpirationTime(maintenant + 300)
    .sign(cle);
}

const reponse = await fetch(`${PORTAIL}/me/teams`, {
  headers: { Authorization: `Bearer ${await jeton({ uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont" })}`, "Accept-Language": "fr" },
});
console.log(reponse.status, await reponse.json());
```

### Python (bibliothèques `PyJWT` et `cryptography`)

```python
import json
import time
import urllib.request

import jwt  # PyJWT ; EdDSA demande aussi le paquet cryptography

PORTAIL = "https://ai-gateway.linagora.com/api/v1"
with open("cle-privee.pem", "rb") as fichier:
    CLE = fichier.read()


def jeton(uid: str, email: str, name: str) -> str:
    """Jeton de cinq minutes au plus : iat et exp calculés au même instant."""
    maintenant = int(time.time())
    revendications = {"iss": "team-manager", "aud": "ai-gateway", "sub": uid, "email": email, "name": name, "iat": maintenant, "exp": maintenant + 300}
    return jwt.encode(revendications, CLE, algorithm="EdDSA", headers={"kid": "team-manager-2026-09"})


requete = urllib.request.Request(
    f"{PORTAIL}/me/teams",
    headers={"Authorization": f"Bearer {jeton('jdupont', 'jdupont@linagora.com', 'Jeanne Dupont')}", "Accept-Language": "fr"},
)
with urllib.request.urlopen(requete) as reponse:
    print(reponse.status, json.load(reponse))
```

### Ligne de commande (OpenSSL 3 et `jq`)

```bash
PORTAIL=https://ai-gateway.linagora.com/api/v1
INTEGRATION=team-manager
KID=team-manager-2026-09
CLE=cle-privee.pem

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

jeton() { # uid, adresse, nom
  local maintenant entete charge message signature
  maintenant=$(date +%s)
  entete=$(jq -cn --arg kid "$KID" '{alg: "EdDSA", typ: "JWT", kid: $kid}' | tr -d '\n' | base64url)
  charge=$(jq -cn --arg iss "$INTEGRATION" --arg sub "$1" --arg email "$2" --arg name "$3" --argjson iat "$maintenant" \
    '{iss: $iss, aud: "ai-gateway", sub: $sub, email: $email, name: $name, iat: $iat, exp: ($iat + 300)}' | tr -d '\n' | base64url)
  # Ed25519 signe le message entier en une fois : OpenSSL le lit dans un fichier, pas sur l'entrée standard.
  message=$(mktemp)
  printf '%s.%s' "$entete" "$charge" > "$message"
  signature=$(openssl pkeyutl -sign -inkey "$CLE" -rawin -in "$message" | base64url)
  rm -f "$message"
  printf '%s.%s.%s' "$entete" "$charge" "$signature"
}

curl -s -H "Authorization: Bearer $(jeton jdupont jdupont@linagora.com "Jeanne Dupont")" "$PORTAIL/me/teams"
```

## 5. Parcours

Les exemples utilisent `curl` et `jq`, avec un jeton pour le collaborateur dans `$JETON` (section 4, ou section 7 en
dev) :

```bash
api() { curl -s -H "Authorization: Bearer $JETON" -H "Content-Type: application/json" -H "Accept-Language: fr" "$@"; }
```

**Équipes et catalogue** (`lecture`). Les équipes du collaborateur, celles qu'il peut demander à rejoindre, et le
catalogue : niveaux de confidentialité, classifications acceptées par chacun, modèles visibles, et le **texte exact de
l'engagement** que le collaborateur doit accepter avant une demande de clé.

```bash
api "$PORTAIL/me/teams"
api "$PORTAIL/teams/joinable"
api "$PORTAIL/catalog" | jq '{commitment, levels}'
```

**Rejoindre une équipe** (`demandes`). La demande part en validation dans le portail (responsables de l'équipe, sinon
admins), avec les mêmes courriels qu'une demande faite dans le portail. Réponse `201` avec son identifiant.

```bash
api -X POST "$PORTAIL/team-access-requests" -d '{"teamId": "<teamId>", "justification": "Rejoindre l'\''équipe du projet"}'
```

**Demander une clé** (`demandes`). Montrez au collaborateur le texte `commitment` du catalogue, et n'envoyez
`"commitment": true` que s'il l'a accepté. Les modèles doivent être autorisés pour l'équipe et accepter le niveau
déclaré, comme dans le portail. `requestedDays` : 1, 7, 30, 90, 180, 365, ou 0 (sans expiration). Pour renouveler une
clé, ajoutez `"renewsRequestId"` : l'identifiant de la demande de la clé à renouveler.

```bash
api -X POST "$PORTAIL/key-requests" -d '{
  "teamId": "<teamId>", "dataLevel": "N1", "models": ["<modèle>"],
  "justification": "Assistant de rédaction", "project": "Compte-rendu hebdomadaire",
  "requestedDays": 90, "commitment": true
}'
```

**Suivre, compléter, annuler** (`lecture`, `demandes`). Statuts : `SUBMITTED`, `NEEDS_COMPLETION` (le validateur
demande un complément, dans `decisionComment`), `APPROVED`, `REFUSED`, `CANCELLED`, `KEY_ISSUED`, `EXPIRED`,
`REVOKED`, chacun avec son libellé traduit (`statusLabel`). Une demande à compléter se complète en renvoyant tous ses
champs (`204`) ; une demande pas encore approuvée s'annule (`204`).

```bash
api "$PORTAIL/requests" | jq '.requests[0]'
api -X PUT "$PORTAIL/key-requests/<id>" -d '{"teamId": "<teamId>", "dataLevel": "N1", "models": ["<modèle>"], "justification": "…", "project": "…", "requestedDays": 90, "commitment": true}'
api -X POST "$PORTAIL/requests/<id>/cancel"
```

**Clés** (`lecture`). Les clés approuvées à retirer (`toPickUp`), avec leur échéance de retrait, puis les clés émises
(`keys`), avec leur expiration, leur dépense et leur budget, jamais leur valeur. Une clé est désignée par l'identifiant
de la demande dont elle vient (`requestId`). Sans le périmètre `cles`, le collaborateur retire sa clé dans le portail
(« Mes clés »).

```bash
api "$PORTAIL/keys"
```

**Retirer, remplacer, révoquer une clé** (`cles`, seconde livraison). Le retrait d'une clé approuvée la génère et rend
sa valeur **une seule fois** (`201`, `{"key": "…", "alias": "…"}`) : montrez-la au collaborateur, sans jamais la
journaliser ni la conserver. Si la réponse se perd, proposez le remplacement : il émet une nouvelle clé aux mêmes
paramètres, avec la même expiration et la même dépense, rendue elle aussi une seule fois, et supprime l'ancienne ; il
est refusé pour une clé expirée ou bloquée par un admin. La révocation coupe la clé (`204`) : la passerelle la refuse
en quelques secondes. Chacune de ces actions envoie au collaborateur un courriel qui nomme l'intégration et l'invite à
prévenir les administrateurs s'il n'en est pas l'auteur. Un collaborateur n'agit que sur ses propres clés, même s'il
est responsable de l'équipe : la clé d'un autre est introuvable (`404`).

```bash
api -X POST "$PORTAIL/key-requests/<requestId>/pickup"    # la clé, une seule fois : ne journalisez pas la réponse
api -X POST "$PORTAIL/keys/<requestId>/replace"
api -X POST "$PORTAIL/keys/<requestId>/revoke"
```

**Renouveler une clé** (`cles`, puis `demandes`). Le brouillon de renouvellement donne les paramètres de la clé (alias,
équipe, niveau, modèles, projet, durée) pour préremplir la demande de renouvellement, déposée ensuite comme une demande
de clé avec `"renewsRequestId"` ; le portail reprend le budget de la clé renouvelée. Au retrait de la nouvelle clé,
l'ancienne est révoquée.

```bash
api "$PORTAIL/keys/<requestId>/renewal-draft"
```

## 6. Erreurs et limites

Toutes les erreurs ont la même forme, avec un code stable, un message dans la langue d'`Accept-Language` (français par
défaut, anglais) et des détails, aux clés en anglais et aux valeurs stables :

```json
{ "error": { "code": "controles_en_echec", "message": "…", "details": { "failedChecks": [{ "id": "niveau_modeles", "offending": ["…"] }] } } }
```

| Statut | Codes |
|---|---|
| 400 | `saisie_invalide` (champs en cause dans `details.fields`), `engagement_requis`, `controles_en_echec` (contrôles en échec dans `details.failedChecks`) |
| 401 | `jeton_invalide` (motif dans `details.reason` : `absent`, `illisible`, `integration_inconnue`, `cle_inconnue`, `algorithme`, `signature`, `destinataire`, `expire`, `futur`, `duree`, `revendication`, avec alors `details.claim`) |
| 403 | `adresse_non_autorisee`, `hors_perimetre` (périmètre exigé dans `details.scope`), `non_membre`, `interdit` |
| 404 | `introuvable` : ressource ou route inconnue, ou appartenant à un autre collaborateur (`details.object`) |
| 409 | `transition_interdite` (`details.case`), `demande_en_cours` et `deja_membre` (`details.team`), `identite_incoherente` |
| 429 | `trop_de_requetes` (plafond de l'intégration) et `trop_de_generations` (retraits et remplacements du collaborateur), avec l'en-tête `Retry-After` en secondes |
| 502 | `passerelle_indisponible` : la passerelle ne répond pas, rien n'a changé |
| 503 | `integration_inactive` : l'intégration est désactivée |

`identite_incoherente` : l'uid du jeton est inconnu du portail et de la passerelle, mais son adresse appartient déjà à
un autre uid. Le portail refuse plutôt que de créer un second collaborateur : vérifiez le `sub` transmis (casse
comprise).

Limites : plafond de requêtes par minute propre à l'intégration ; corps des requêtes en JSON, de 16 Kio au plus, sans
champ inconnu ; toutes les réponses portent `Cache-Control: no-store`. Un collaborateur retire ou remplace au plus
cinq clés par tranche de dix minutes, dans le portail et par l'API confondus (`429 trop_de_generations`). Ne journalisez
jamais une réponse qui contient une clé.

## 7. Développer contre l'environnement de dev

L'environnement de dev du portail (voir le README du portail, `portal/README.md`) comprend une intégration « demo »,
active, avec tous les périmètres et les adresses locales et privées. Sa clé privée est créée sur votre poste, hors
dépôt, dans `portal/dev/.integration-demo/`. Depuis `portal/` :

```bash
node dev/integration-demo.mjs installer                         # déclare (ou remet en état) l'intégration « demo »
JETON=$(node dev/integration-demo.mjs jeton jdupont jdupont@example.org "Jeanne Dupont")
PORTAIL=http://127.0.0.1:54600/api/v1                           # par le Caddy de dev, comme en production
```

Les appels passent par le Caddy de dev, qui transmet l'adresse de l'appelant au portail comme en production. Les
exemples de la section 4 fonctionnent tels quels avec `INTEGRATION=demo`, `KID=demo-1` et la clé
`dev/.integration-demo/cle-privee.pem`.

Pour éprouver votre propre intégration : connectez-vous au portail de dev comme admin
(`http://localhost:3100`, uid `mmaudet`), déclarez-la dans « Gestion » puis « Intégrations » avec vos adresses (en
dev, celles du réseau de Docker : `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), ajoutez votre clé publique et
activez-la. Les demandes déposées par l'API se valident dans « Gestion » puis « Demandes » ; les courriels arrivent
dans Mailpit (`http://127.0.0.1:54825`).

## 8. Recette et mise en service

1. L'intégrateur fournit les éléments de la section 2.
2. Un admin déclare l'intégration dans l'onglet « Intégrations » : elle est créée **désactivée**. Il ajoute la clé
   publique et vérifie son empreinte avec celle de l'intégrateur. Chaque changement est annoncé par courriel à tous les
   admins et inscrit au journal d'audit.
3. Recette commune sur un vrai compte : les équipes, les demandes et les clés lues par l'intégration sont celles que le
   portail montre à ce collaborateur ; une demande déposée par l'API arrive dans la file de validation du portail.
4. L'admin **active** l'intégration. L'ouverture du périmètre `cles` se décide plus tard, après la recette de la
   seconde livraison.
5. Seconde livraison : l'intégrateur confirme par écrit qu'il ne journalise aucune réponse de l'API ; une recette
   commune sur son compte vérifie le retrait, le remplacement, la révocation et leurs courriels ; puis l'admin ajoute
   le périmètre `cles` à l'intégration.

## 9. Rotation des clés

1. Créez une nouvelle paire de clés, avec un nouvel identifiant de clé (`kid`).
2. Faites ajouter la nouvelle clé publique par un admin : les deux clés sont alors acceptées.
3. Signez vos jetons avec la nouvelle clé.
4. Faites mettre l'ancienne clé hors service : les jetons qu'elle signe sont refusés aussitôt. Une clé hors service
   reste inscrite ; son `kid` ne peut pas resservir.

## 10. Coupure

- Un admin **désactive** l'intégration d'un clic dans l'onglet « Intégrations » : ses appels reçoivent aussitôt
  `503 integration_inactive`. Une intégration ne se supprime jamais : le journal d'audit garde son canal lisible.
- Si une clé privée a fuité : prévenez les admins, qui mettent la clé hors service (les jetons qu'elle signe sont
  refusés en `401`) ou désactivent l'intégration ; reprenez ensuite la rotation (section 9) avec une nouvelle paire.
- Un jeton volé ne sert que depuis les adresses de l'intégration, et moins de cinq minutes.
