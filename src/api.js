import { OktaAuth } from "@okta/okta-auth-js";
import { API_BASE_URL, OKTA_ISSUER, OKTA_CLIENT_ID } from "./config";

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// Okta Auth JS client
// Initialised once at module load. Uses the Okta Auth JS SDK which handles
// silent token renewal via postMessage — works correctly inside iframes such
// as the Amazon Connect Agent Workspace.
// ---------------------------------------------------------------------------
let _oktaAuth = null;

function getOktaAuth() {
  if (!_oktaAuth) {
    if (!OKTA_ISSUER || !OKTA_CLIENT_ID) {
      throw new ApiError("Okta is not configured.", 500);
    }
    _oktaAuth = new OktaAuth({
      issuer: OKTA_ISSUER,
      clientId: OKTA_CLIENT_ID,
      redirectUri: window.location.origin,
      scopes: ["openid", "profile"],
      pkce: false,          // use implicit flow — no auth code exchange needed
      tokenManager: {
        autoRenew: true,    // SDK renews the token automatically before expiry
        storage: "memory",  // store tokens in memory only — no localStorage
      },
    });
  }
  return _oktaAuth;
}

// ---------------------------------------------------------------------------
// Okta token retrieval
// Gets a cached ID token from the SDK token manager, or fetches a fresh one
// silently using getWithoutPrompt (no login prompt shown to the agent).
// ID tokens are used (not access tokens) because their audience is always the
// OIDC client ID, which the Lambda can verify without a custom auth server.
// ---------------------------------------------------------------------------
async function getOktaToken() {
  const oktaAuth = getOktaAuth();

  // Check if we already have a valid ID token in the token manager
  try {
    const existingToken = await oktaAuth.tokenManager.get("idToken");
    if (existingToken && !oktaAuth.tokenManager.hasExpired(existingToken)) {
      return existingToken.idToken;
    }
  } catch {
    // Token manager empty or expired — fall through to fetch a fresh token
  }

  // Fetch a fresh ID token silently — agent is already authenticated via Okta SSO.
  // We use id_token (not access_token) because its audience is always the OIDC
  // client ID, which the Lambda can verify without a custom Okta authorization server.
  try {
    const { tokens } = await oktaAuth.token.getWithoutPrompt({
      responseType: ["id_token"],
      scopes: ["openid", "profile"],
    });

    if (!tokens?.idToken) {
      throw new ApiError("Unable to obtain authentication token.", 401);
    }

    // Store for future calls
    oktaAuth.tokenManager.setTokens(tokens);
    return tokens.idToken.idToken;
  } catch (error) {
    if (error instanceof ApiError) throw error;

    // Log the real Okta error so we can diagnose it in the browser console
    console.error("[Okta] getWithoutPrompt failed:", {
      name: error?.name,
      message: error?.message,
      errorCode: error?.errorCode,
      errorSummary: error?.errorSummary,
      error,
    });

    // Okta returned an error — agent session may have expired
    throw new ApiError(
      `Authentication failed (${error?.errorCode || error?.name || "unknown"}). Please log in again.`,
      401
    );
  }
}

// ---------------------------------------------------------------------------
// HTTP request helper — attaches Okta Bearer token on every call
// ---------------------------------------------------------------------------
async function request(path, options = {}) {
  const token = await getOktaToken();
  const body = options.body ? JSON.stringify(options.body) : null;

  const fetchResponse = await fetch(`${API_BASE_URL}${path}`, {
    method: options.method || "GET",
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body } : {}),
  });

  const contentType = fetchResponse.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await fetchResponse.json()
    : null;

  if (!fetchResponse.ok) {
    throw new ApiError(
      payload?.error || "The proficiency service request failed.",
      fetchResponse.status
    );
  }

  return payload;
}

export function listAttributes() {
  return request("/attributes");
}

export function listProficiencies(agentArn) {
  const params = new URLSearchParams({ agentArn });
  return request(`/proficiencies?${params.toString()}`);
}

export function updateProficiencies(agentArn, proficiencies) {
  return request("/proficiencies", {
    method: "PUT",
    body: { agentArn, proficiencies }
  });
}

export function deleteProficiencies(agentArn, proficiencies) {
  return request("/proficiencies", {
    method: "DELETE",
    body: { agentArn, proficiencies }
  });
}
