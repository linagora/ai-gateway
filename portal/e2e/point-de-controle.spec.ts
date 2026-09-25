import { type Browser, type BrowserContext, expect, test } from "@playwright/test";

/*
 * Point de contrôle de /admin et /stats : Caddy de dev (dev/Caddyfile, même fragment que la production)
 * → portail → service factice qui affiche l'identité reçue. Lecteur du reporting : PORTAL_REPORTING_UIDS=lecteur-e2e.
 */
const gate = "http://localhost:54600";
const suffix = Date.now().toString(36);
const admin = { uid: "mmaudet", email: "mmaudet@linagora.com", name: "Admin E2E" };
const lectrice = { uid: "lecteur-e2e", email: "lecteur-e2e@example.org", name: "Hélène Lecteur" };
const salarie = { uid: `e2e-${suffix}`, email: `e2e-${suffix}@example.org`, name: `Salarié ${suffix}` };

test.describe.configure({ mode: "serial" });

const sessions: Partial<Record<"admin" | "lectrice" | "salarie" | "anonyme", BrowserContext>> = {};

async function loggedIn(browser: Browser, user: typeof admin): Promise<BrowserContext> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto("/");
  await page.getByRole("button", { name: /LemonLDAP/ }).click();
  await page.locator('input[name="username"]').fill(user.uid);
  await page.locator('textarea[name="claims"]').fill(JSON.stringify({ email: user.email, name: user.name }));
  await page.getByRole("button", { name: "Sign-in" }).click();
  await expect(page.getByRole("heading", { name: `Bonjour ${user.name}` })).toBeVisible();
  await page.close();
  return context;
}

test.beforeAll(async ({ browser }) => {
  sessions.admin = await loggedIn(browser, admin);
  sessions.lectrice = await loggedIn(browser, lectrice);
  sessions.salarie = await loggedIn(browser, salarie);
  sessions.anonyme = await browser.newContext();
});

test.afterAll(async () => {
  await Promise.all(Object.values(sessions).map((s) => s?.close()));
});

test("un admin passe sur /admin, et le service reçoit son identité", async () => {
  const response = await sessions.admin!.request.get(`${gate}/admin/ui/`, { maxRedirects: 0 });
  expect(await response.text()).toBe("service=/admin/ui/ utilisateur=mmaudet role=admin email=mmaudet@linagora.com nom=Admin%20E2E");
});

test("un salarié qui n'est pas admin est refusé sur /admin", async () => {
  const response = await sessions.salarie!.request.get(`${gate}/admin/ui/`, { maxRedirects: 0 });
  expect({ status: response.status(), accesReserve: (await response.text()).includes("Accès réservé") }).toEqual({ status: 403, accesReserve: true });
});

test("une lectrice du reporting passe sur /stats en lecture, avec son nom encodé", async () => {
  const response = await sessions.lectrice!.request.get(`${gate}/stats/superset/welcome/`, { maxRedirects: 0 });
  expect(await response.text()).toBe(
    "service=/stats/superset/welcome/ utilisateur=lecteur-e2e role=reader email=lecteur-e2e@example.org nom=H%C3%A9l%C3%A8ne%20Lecteur",
  );
});

test("une lectrice du reporting est refusée sur /admin", async () => {
  const response = await sessions.lectrice!.request.get(`${gate}/admin/ui/`, { maxRedirects: 0 });
  expect(response.status()).toBe(403);
});

test("sans session, /stats renvoie vers la connexion du portail puis vers l'adresse demandée", async () => {
  const response = await sessions.anonyme!.request.get(`${gate}/stats/tableaux?id=3`, { maxRedirects: 0 });
  expect({ status: response.status(), location: response.headers()["location"] }).toEqual({
    status: 302,
    location: "http://localhost:3100/api/auth/signin?callbackUrl=http%3A%2F%2Flocalhost%3A3100%2Fstats%2Ftableaux%3Fid%3D3",
  });
});

test("un en-tête d'identité forgé par le client est ignoré", async () => {
  const forged = { "X-Portal-User": "mmaudet", "X-Portal-Role": "admin" };
  const anonyme = await sessions.anonyme!.request.get(`${gate}/admin/ui/`, { headers: forged, maxRedirects: 0 });
  const salarieForge = await sessions.salarie!.request.get(`${gate}/admin/ui/`, { headers: forged, maxRedirects: 0 });
  const adminForge = await sessions.admin!.request.get(`${gate}/admin/ui/`, { headers: { "X-Portal-User": "pirate" }, maxRedirects: 0 });
  expect({ anonyme: anonyme.status(), salarie: salarieForge.status(), admin: await adminForge.text() }).toEqual({
    anonyme: 302,
    salarie: 403,
    admin: "service=/admin/ui/ utilisateur=mmaudet role=admin email=mmaudet@linagora.com nom=Admin%20E2E",
  });
});
