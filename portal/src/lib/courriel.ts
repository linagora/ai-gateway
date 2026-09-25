import nodemailer from "nodemailer";

/** Courriel à envoyer : texte brut, bilingue (français puis anglais). */
export interface Message {
  to: string[];
  subject: string;
  text: string;
}

/** Envoi des courriels du portail : SMTP en production, boîte d'envoi en mémoire dans les tests. */
export interface Mailer {
  send(message: Message): Promise<void>;
}

/** Valeur de configuration renseignée (ni vide, ni en attente de saisie « __ASK__ »). */
function renseignee(valeur: string | undefined): string | null {
  return valeur && valeur.trim() && !valeur.includes("__ASK__") ? valeur.trim() : null;
}

/** Expéditeur SMTP d'après la configuration ; null tant que l'hôte ou l'expéditeur ne sont pas configurés. */
export function mailerFromEnv(env: Record<string, string | undefined> = process.env): Mailer | null {
  const host = renseignee(env.SMTP_HOST);
  const from = renseignee(env.SMTP_FROM);
  if (!host || !from) return null;
  const port = Number(renseignee(env.SMTP_PORT) ?? 587);
  const user = renseignee(env.SMTP_USER);
  const pass = renseignee(env.SMTP_PASSWORD);
  const transport = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user && pass ? { user, pass } : undefined,
    // L'action qui envoie le courriel l'attend : un serveur SMTP lent ou muet ne la retient que quelques secondes
    // (par défaut, nodemailer attend jusqu'à deux minutes la connexion et dix minutes sur un échange bloqué).
    connectionTimeout: 5_000,
    greetingTimeout: 5_000,
    socketTimeout: 10_000,
  });
  return {
    async send(message) {
      await transport.sendMail({ from, to: message.to, subject: message.subject, text: message.text });
    },
  };
}

/** Liste d'adresses séparées par des virgules (admins à notifier). */
export function addressesFromEnv(valeur: string | undefined): string[] {
  return (renseignee(valeur) ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean);
}
