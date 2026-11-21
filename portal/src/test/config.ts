/** Environnement de dev (dev/docker-compose.yml) utilisé par les tests d'intégration : valeurs FACTICES. */
export const TEST_DATABASE_URL = "postgresql://postgres:dev@127.0.0.1:55432/portal_test";
export const TEST_LITELLM_BASE_URL = "http://127.0.0.1:54400/admin";
export const TEST_LITELLM_MASTER_KEY = "sk-dev-master-key";
/** Fournisseur factice de transcription du Caddy de dev, à l'adresse où le joint le LiteLLM de dev (réseau Docker). */
export const TEST_TRANSCRIPTION_API_BASE = "http://caddy:8082/v1";
