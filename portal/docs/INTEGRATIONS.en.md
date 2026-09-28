# AI Gateway portal integration kit

This guide is for teams who want an application (an **integration**) to act on behalf of LINAGORA employees in the
AI Gateway portal: request an API key, join a team, follow their requests and keys. It describes the mechanism, what to
provide, how to sign tokens, the typical flows, the errors, development against the dev environment, then going live,
key rotation and shutdown.

The contract can be read and tried in the portal, with Swagger UI, by any signed-in employee:
<https://ai-gateway.linagora.com/documentation/api>. To try a route, click “Authorize” and paste a token signed by your
integration (section 4): the call leaves from your browser and goes through the same checks as the integration's calls,
IP address included.

The reference contract is the OpenAPI 3.1 document of the API, served by the portal to any authenticated integration
that has the `lecture` scope:
`GET https://ai-gateway.linagora.com/api/v1/openapi.json` (in dev: `http://127.0.0.1:54600/api/v1/openapi.json`). Its
source is in the repository: `portal/src/lib/integrations/openapi-v1.json`.

## 1. Principles

- **Integration**: a third-party application, declared by a portal administrator in the “Integrations” tab of the
  administration. Its identifier (for instance `team-manager`) never changes.
- **Employee**: the person the integration acts for, identified by their LDAP uid. The integration acts for one
  employee at a time, on their own requests and keys, **never** with the rights of an administrator or of a team
  manager, even when the employee is one in the portal. Requests are still examined and approved in the portal, by the
  same people, with the same rules and the same emails.
- **Integration token**: every call carries a JWT valid for five minutes at most, **signed by the integration** with its
  private key. The portal checks it with the public key registered by the administrator: no secret is shared, and the
  portal cannot forge a token.
- **Scopes**: what the administrator allows the integration to do.
  - `lecture` (read): the employee's teams, the catalog, their requests and keys, and the API contract;
  - `demandes` (requests): request a key or access to a team, complete and cancel a request;
  - `cles` (keys): pick up, replace and revoke a key, prepare its renewal (second delivery, opened by an administrator
    after its acceptance test, section 8).
- **Channel**: every action made through the API is recorded in the portal's audit log with the integration's
  identifier, which tells it apart from actions made in the portal.

Every call goes through these checks, in this order: valid token (otherwise 401), active integration (otherwise 503),
caller's IP address in the integration's list (otherwise 403), request limit (otherwise 429), route within the scopes
(otherwise 403). On the first call for an employee, the portal registers them with the gateway, as on their first
sign-in to the portal.

## 2. What an integration provides to be declared

To send to the portal administrators:

| Item | Details |
|---|---|
| Identifier | 2 to 40 characters: lowercase letters, digits and single hyphens between them (`team-manager`). It is the issuer (`iss`) of the tokens and the channel in the audit log; it never changes. |
| Name | As it will appear in the administration and in the emails to administrators. |
| Public key | PEM format (`-----BEGIN PUBLIC KEY-----`), Ed25519 preferably (algorithm `EdDSA`), otherwise RSA of at least 2,048 bits (`RS256`), with its key identifier (`kid`, 1 to 64 letters, digits, dots, hyphens or underscores) and its fingerprint (section 3). **Never the private key.** |
| Outgoing IP addresses | Addresses or CIDR ranges (IPv4 or IPv6) from which the integration calls the API; any other call is rejected. |
| Requested scopes | `lecture`, `demandes`, then `cles` after the acceptance test of the second delivery. |
| Rate limit | Requests per minute, all employees combined; 120 by default. |
| Employee identity | Confirmation that the tokens' `sub` is the LDAP uid, exactly the one LemonLDAP::NG gives to the portal. |

## 3. Create the key pair

With OpenSSL 3:

```bash
openssl genpkey -algorithm ed25519 -out private-key.pem         # keep it secret, on the integration's side only
openssl pkey -in private-key.pem -pubout -out public-key.pem    # to send to the administrators
chmod 600 private-key.pem
```

Fingerprint of the public key, shown as `SHA256:…` by the “Integrations” tab and by the emails to administrators; the
administrators compare it with the one you give them:

```bash
openssl pkey -pubin -in public-key.pem -outform DER | openssl dgst -sha256 -binary | openssl base64 -A | tr -d '='
```

Without Ed25519: `openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out private-key.pem`, and the `RS256`
algorithm.

## 4. The integration token

A JWT (compact form, three base64url parts):

- header: `alg` is the algorithm of the registered key (`EdDSA` or `RS256`, no other, never `none`), `kid` the
  identifier of that key;
- claims:
  - `iss`: the integration identifier;
  - `aud`: `ai-gateway`;
  - `sub`: the employee's LDAP uid;
  - `email` and `name`: their address and display name;
  - `iat` and `exp`: `exp` at most 300 seconds after `iat`, both computed at the same instant; the portal tolerates a
    30-second clock skew.

Sign a token for each call, or reuse it within its short validity. It is sent in the header
`Authorization: Bearer <token>`. The examples below read the private key from `private-key.pem`.

### TypeScript (Node.js, `jose` library)

```ts
import { readFileSync } from "node:fs";
import { importPKCS8, SignJWT } from "jose";

const PORTAL = "https://ai-gateway.linagora.com/api/v1";
const key = await importPKCS8(readFileSync("private-key.pem", "utf8"), "EdDSA");

/** Token valid for five minutes at most: iat and exp computed at the same instant. */
async function token(employee: { uid: string; email: string; name: string }): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: employee.email, name: employee.name })
    .setProtectedHeader({ alg: "EdDSA", kid: "team-manager-2026-09" })
    .setIssuer("team-manager")
    .setAudience("ai-gateway")
    .setSubject(employee.uid)
    .setIssuedAt(now)
    .setExpirationTime(now + 300)
    .sign(key);
}

const response = await fetch(`${PORTAL}/me/teams`, {
  headers: { Authorization: `Bearer ${await token({ uid: "jdupont", email: "jdupont@linagora.com", name: "Jeanne Dupont" })}`, "Accept-Language": "en" },
});
console.log(response.status, await response.json());
```

### Python (`PyJWT` and `cryptography` libraries)

```python
import json
import time
import urllib.request

import jwt  # PyJWT; EdDSA also requires the cryptography package

PORTAL = "https://ai-gateway.linagora.com/api/v1"
with open("private-key.pem", "rb") as file:
    KEY = file.read()


def token(uid: str, email: str, name: str) -> str:
    """Token valid for five minutes at most: iat and exp computed at the same instant."""
    now = int(time.time())
    claims = {"iss": "team-manager", "aud": "ai-gateway", "sub": uid, "email": email, "name": name, "iat": now, "exp": now + 300}
    return jwt.encode(claims, KEY, algorithm="EdDSA", headers={"kid": "team-manager-2026-09"})


request = urllib.request.Request(
    f"{PORTAL}/me/teams",
    headers={"Authorization": f"Bearer {token('jdupont', 'jdupont@linagora.com', 'Jeanne Dupont')}", "Accept-Language": "en"},
)
with urllib.request.urlopen(request) as response:
    print(response.status, json.load(response))
```

### Command line (OpenSSL 3 and `jq`)

```bash
PORTAL=https://ai-gateway.linagora.com/api/v1
INTEGRATION=team-manager
KID=team-manager-2026-09
KEY=private-key.pem

base64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

token() { # uid, email, name
  local now header payload message signature
  now=$(date +%s)
  header=$(jq -cn --arg kid "$KID" '{alg: "EdDSA", typ: "JWT", kid: $kid}' | tr -d '\n' | base64url)
  payload=$(jq -cn --arg iss "$INTEGRATION" --arg sub "$1" --arg email "$2" --arg name "$3" --argjson iat "$now" \
    '{iss: $iss, aud: "ai-gateway", sub: $sub, email: $email, name: $name, iat: $iat, exp: ($iat + 300)}' | tr -d '\n' | base64url)
  # Ed25519 signs the whole message at once: OpenSSL reads it from a file, not from standard input.
  message=$(mktemp)
  printf '%s.%s' "$header" "$payload" > "$message"
  signature=$(openssl pkeyutl -sign -inkey "$KEY" -rawin -in "$message" | base64url)
  rm -f "$message"
  printf '%s.%s.%s' "$header" "$payload" "$signature"
}

curl -s -H "Authorization: Bearer $(token jdupont jdupont@linagora.com "Jeanne Dupont")" "$PORTAL/me/teams"
```

## 5. Flows

The examples use `curl` and `jq`, with a token for the employee in `$TOKEN` (section 4, or section 7 in dev):

```bash
api() { curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -H "Accept-Language: en" "$@"; }
```

**Teams and catalog** (`lecture`). The employee's teams, the teams they may ask to join, and the catalog:
confidentiality levels, the classifications each accepts, visible models, and the **exact commitment text** the employee
must accept before a key request.

```bash
api "$PORTAL/me/teams"
api "$PORTAL/teams/joinable"
api "$PORTAL/catalog" | jq '{commitment, levels}'
```

**Join a team** (`demandes`). The request goes to approval in the portal (managers of the team, otherwise
administrators), with the same emails as a request made in the portal. Answer `201` with its identifier.

```bash
api -X POST "$PORTAL/team-access-requests" -d '{"teamId": "<teamId>", "justification": "Join the project team"}'
```

**Request a key** (`demandes`). Show the employee the `commitment` text of the catalog, and send `"commitment": true`
only if they accepted it. The models must be allowed for the team and accept the declared level, as in the portal.
`requestedDays`: 1, 7, 30, 90, 180, 365, or 0 (no expiration). To renew a key, add `"renewsRequestId"`: the identifier
of the request of the key to renew.

```bash
api -X POST "$PORTAL/key-requests" -d '{
  "teamId": "<teamId>", "dataLevel": "N1", "models": ["<model>"],
  "justification": "Writing assistant", "project": "Weekly report",
  "requestedDays": 90, "commitment": true
}'
```

**Follow, complete, cancel** (`lecture`, `demandes`). Statuses: `SUBMITTED`, `NEEDS_COMPLETION` (the examiner asks for
more information, in `decisionComment`), `APPROVED`, `REFUSED`, `CANCELLED`, `KEY_ISSUED`, `EXPIRED`, `REVOKED`, each
with its translated label (`statusLabel`). A request to complete is completed by sending all its fields again (`204`);
a request not yet approved can be cancelled (`204`).

```bash
api "$PORTAL/requests" | jq '.requests[0]'
api -X PUT "$PORTAL/key-requests/<id>" -d '{"teamId": "<teamId>", "dataLevel": "N1", "models": ["<model>"], "justification": "…", "project": "…", "requestedDays": 90, "commitment": true}'
api -X POST "$PORTAL/requests/<id>/cancel"
```

**Keys** (`lecture`). Approved keys waiting to be picked up (`toPickUp`), with their pickup deadline, then issued keys
(`keys`), with their expiration, spend and budget, never their value. A key is identified by the request it comes from
(`requestId`). Without the `cles` scope, the employee picks up their key in the portal (“My keys”).

```bash
api "$PORTAL/keys"
```

**Pick up, replace, revoke a key** (`cles`, second delivery). Picking up an approved key generates it and returns its
value **once** (`201`, `{"key": "…", "alias": "…"}`): show it to the employee, and never log or store it. If the
response is lost, offer the replacement: it issues a new key with the same parameters, expiry and spend, also returned
once, and deletes the old one; it is refused for an expired key or one blocked by an administrator or a manager of its
team. Revocation cuts the key off (`204`): the gateway refuses it within seconds. Each of these actions sends the
employee an email that names the integration and asks them to warn the administrators if they did not make it. An
employee acts on their own keys only, even as a manager of the team: another employee's key is not found (`404`).

```bash
api -X POST "$PORTAL/key-requests/<requestId>/pickup"    # the key, once: do not log the response
api -X POST "$PORTAL/keys/<requestId>/replace"
api -X POST "$PORTAL/keys/<requestId>/revoke"
```

**Renew a key** (`cles`, then `demandes`). The renewal draft gives the key's parameters (alias, team, level, models,
project, validity) to prefill the renewal request, then made as a key request with `"renewsRequestId"`; the portal
takes over the budget of the renewed key. When the new key is picked up, the old one is revoked.

```bash
api "$PORTAL/keys/<requestId>/renewal-draft"
```

## 6. Errors and limits

All errors share one shape, with a stable code, a message in the language of `Accept-Language` (French by default,
English) and details, with English keys and stable values:

```json
{ "error": { "code": "controles_en_echec", "message": "…", "details": { "failedChecks": [{ "id": "niveau_modeles", "offending": ["…"] }] } } }
```

| Status | Codes |
|---|---|
| 400 | `saisie_invalide` (fields at fault in `details.fields`), `engagement_requis`, `controles_en_echec` (failed checks in `details.failedChecks`) |
| 401 | `jeton_invalide` (reason in `details.reason`: `absent`, `illisible`, `integration_inconnue`, `cle_inconnue`, `algorithme`, `signature`, `destinataire`, `expire`, `futur`, `duree`, `revendication`, then with `details.claim`) |
| 403 | `adresse_non_autorisee`, `hors_perimetre` (required scope in `details.scope`), `non_membre`, `interdit` |
| 404 | `introuvable`: unknown resource or route, or one that belongs to another employee (`details.object`) |
| 409 | `transition_interdite` (`details.case`), `demande_en_cours` and `deja_membre` (`details.team`), `identite_incoherente` |
| 429 | `trop_de_requetes` (integration's request limit) and `trop_de_generations` (the employee's pickups and replacements), with the `Retry-After` header in seconds |
| 502 | `passerelle_indisponible`: the gateway does not answer, nothing changed |
| 503 | `integration_inactive`: the integration is disabled |

`identite_incoherente`: the token's uid is unknown to the portal and to the gateway, but its email address already
belongs to another uid. The portal refuses rather than create a second employee: check the `sub` you send (case
included).

Limits: per-minute request limit of the integration; JSON request bodies of 16 KiB at most, without unknown fields;
every response carries `Cache-Control: no-store`. An employee picks up or replaces at most five keys per ten minutes,
in the portal and through the API combined (`429 trop_de_generations`). Never log a response that contains a key.

## 7. Develop against the dev environment

The portal's dev environment (see the portal README, `portal/README.md`) includes a “demo” integration, active, with
every scope and the local and private addresses. Its private key is created on your machine, outside the repository, in
`portal/dev/.integration-demo/`. From `portal/`:

```bash
node dev/integration-demo.mjs installer                         # declares (or resets) the “demo” integration
TOKEN=$(node dev/integration-demo.mjs jeton jdupont jdupont@example.org "Jeanne Dupont")
PORTAL=http://127.0.0.1:54600/api/v1                            # through the dev Caddy, as in production
```

Calls go through the dev Caddy, which passes the caller's address to the portal as in production. The examples of
section 4 work as they are with `INTEGRATION=demo`, `KID=demo-1` and the key `dev/.integration-demo/cle-privee.pem`.

To test your own integration: sign in to the dev portal as an administrator (`http://localhost:3100`, uid `mmaudet`),
declare it in “Administration” then “Integrations” with your addresses (in dev, those of the Docker network:
`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), add your public key and enable it. Requests made through the API are
approved in “Administration” then “Requests”; emails arrive in Mailpit (`http://127.0.0.1:54825`).

## 8. Acceptance and going live

1. The integrator provides the items of section 2.
2. An administrator declares the integration in the “Integrations” tab: it is created **disabled**. They add the public
   key and check its fingerprint against the integrator's. Every change is announced by email to all administrators
   and recorded in the audit log.
3. Joint acceptance test on a real account: the teams, requests and keys read by the integration are those the portal
   shows to this employee; a request made through the API reaches the portal's approval queue.
4. The administrator **enables** the integration. Opening the `cles` scope is decided later, after the acceptance test
   of the second delivery.
5. Second delivery: the integrator confirms in writing that they log no API response; a joint acceptance test on
   their account checks pickup, replacement, revocation and their emails; then the administrator adds the `cles` scope
   to the integration.

## 9. Key rotation

1. Create a new key pair, with a new key identifier (`kid`).
2. Have an administrator add the new public key: both keys are then accepted.
3. Sign your tokens with the new key.
4. Have the old key retired: tokens it signs are rejected at once. A retired key stays listed; its `kid` cannot be
   reused.

## 10. Shutdown

- An administrator **disables** the integration with one click in the “Integrations” tab: its calls get
  `503 integration_inactive` at once. An integration is never deleted: the audit log keeps its channel readable.
- If a private key leaked: warn the administrators, who retire the key (tokens it signs are rejected with `401`) or
  disable the integration; then rotate (section 9) with a new pair.
- A stolen token only works from the integration's addresses, and for less than five minutes.
