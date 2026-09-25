import type { Mailer, Message } from "@/lib/courriel";

/** Expéditeur simulé (frontière avec le serveur SMTP) : garde les messages envoyés en mémoire. */
export class FakeMailer implements Mailer {
  readonly outbox: Message[] = [];
  /** Simule un serveur de courriel injoignable. */
  panne = false;

  async send(message: Message): Promise<void> {
    if (this.panne) throw new Error("serveur SMTP injoignable");
    this.outbox.push(message);
  }
}
