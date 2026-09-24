import { vi } from "vitest";

// « server-only » lève une erreur hors de l'environnement serveur de React : neutralisé dans les tests.
vi.mock("server-only", () => ({}));
