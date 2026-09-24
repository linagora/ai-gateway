import { describe, expect, test } from "vitest";
import { FakeLiteLLM } from "@/test/fake-litellm";
import { provisionUser } from "./provisioning";

const user = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Michel-Marie Maudet", isAdmin: false };

describe("provisionUser (F-02)", () => {
  test("à la première connexion, l'utilisateur est créé dans LiteLLM avec son e-mail", async () => {
    const litellm = new FakeLiteLLM();
    await provisionUser({ litellm }, user);
    expect((await litellm.getUser("mmaudet"))?.email).toBe("mmaudet@linagora.com");
  });

  test("aux connexions suivantes, l'utilisateur existant est conservé sans erreur", async () => {
    const litellm = new FakeLiteLLM();
    await provisionUser({ litellm }, user);
    await expect(provisionUser({ litellm }, user)).resolves.toBeUndefined();
  });
});
