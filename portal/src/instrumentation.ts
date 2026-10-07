/**
 * Démarrage du serveur du portail (convention de Next.js, appelée une fois par instance) : supervision des modèles, sur
 * le seul environnement Node.js, où tournent Prisma et le client LiteLLM.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { demarrerSupervision } = await import("./lib/supervision-planifiee");
    demarrerSupervision();
  }
}
