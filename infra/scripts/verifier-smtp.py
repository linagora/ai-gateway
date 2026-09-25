#!/usr/bin/env python3
"""Vérifie la connexion et l'authentification SMTP du portail, sans envoyer de courriel ni afficher de secret.

La configuration est lue sur l'entrée standard, au format NOM=valeur : celle que le conteneur du portail a
réellement reçue, après l'interprétation de .env par Docker Compose (un « $ » dans une valeur, par exemple).
Usage :
  cd /opt/linagora-ia && docker compose exec -T portal env | ./scripts/verifier-smtp.py
"""
import smtplib
import ssl
import sys


def renseignee(valeur):
    """Valeur de configuration renseignée (ni vide, ni en attente de saisie « __ASK__ »), comme le portail."""
    return valeur.strip() if valeur and valeur.strip() and "__ASK__" not in valeur else None


env = {}
for ligne in sys.stdin:
    nom, _, valeur = ligne.rstrip("\n").partition("=")
    if nom.startswith("SMTP_"):
        env[nom] = valeur

hote = renseignee(env.get("SMTP_HOST"))
utilisateur = renseignee(env.get("SMTP_USER"))
mot_de_passe = renseignee(env.get("SMTP_PASSWORD"))
port = int(renseignee(env.get("SMTP_PORT")) or 587)
if not hote or not renseignee(env.get("SMTP_FROM")):
    sys.exit("• SMTP_HOST ou SMTP_FROM non renseignée : le portail n'envoie aucun courriel.")

contexte = ssl.create_default_context()
try:
    # Port 465 : TLS implicite ; sinon STARTTLS si le serveur le propose, comme nodemailer.
    serveur = smtplib.SMTP_SSL(hote, port, timeout=10, context=contexte) if port == 465 else smtplib.SMTP(hote, port, timeout=10)
    with serveur:
        serveur.ehlo()
        if port != 465 and serveur.has_extn("starttls"):
            serveur.starttls(context=contexte)
            serveur.ehlo()
        if utilisateur and mot_de_passe:
            serveur.login(utilisateur, mot_de_passe)
            print(f"• {hote}:{port} : connexion chiffrée et authentification de {utilisateur} réussies")
        else:
            print(f"• {hote}:{port} : connexion réussie, sans authentification (utilisateur ou mot de passe non renseigné)")
except smtplib.SMTPAuthenticationError as e:
    sys.exit(f"• {hote}:{port} : authentification de {utilisateur} refusée (code {e.smtp_code})")
except (OSError, smtplib.SMTPException) as e:
    sys.exit(f"• {hote}:{port} : échec ({type(e).__name__})")
