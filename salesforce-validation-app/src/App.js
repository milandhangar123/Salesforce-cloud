import React, { useState, useEffect } from "react";
import "./App.css";

const CLIENT_ID = process.env.REACT_APP_SF_CLIENT_ID;
const REDIRECT_URI = process.env.REACT_APP_SF_REDIRECT_URI;
const LOGIN_URL = "https://login.salesforce.com";
const PROXY_URL = "https://salesforce-proxy-vde6.onrender.com";

const generateCodeVerifier = () => {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const generateCodeChallenge = async (verifier) => {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

function App() {
  const [accessToken, setAccessToken] = useState(null);
  const [instanceUrl, setInstanceUrl] = useState(null);
  const [validationRules, setValidationRules] = useState([]);
  const [username, setUsername] = useState(
    localStorage.getItem("sf_username") || "",
  );
  const [orgName, setOrgName] = useState(localStorage.getItem("sf_org") || "");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const savedToken = localStorage.getItem("sf_access_token");
    const savedInstance = localStorage.getItem("sf_instance_url");
    if (savedToken && savedInstance) {
      setAccessToken(savedToken);
      setInstanceUrl(savedInstance);
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code) {
      setMessage("Authenticating...");
      exchangeCodeForToken(code);
      window.history.replaceState({}, document.title, "/");
    }
  }, []);

  const loginWithSalesforce = async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem("pkce_verifier", verifier);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "full refresh_token",
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    window.location.href = `${LOGIN_URL}/services/oauth2/authorize?${params}`;
  };

  const exchangeCodeForToken = async (code) => {
    const verifier = sessionStorage.getItem("pkce_verifier");
    try {
      const res = await fetch(`${PROXY_URL}/auth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: CLIENT_ID,
          client_secret: process.env.REACT_APP_SF_CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          code,
          ...(verifier && { code_verifier: verifier }),
        }).toString(),
      });
      const data = await res.json();
      if (data.access_token) {
        localStorage.setItem("sf_access_token", data.access_token);
        localStorage.setItem("sf_instance_url", data.instance_url);
        setAccessToken(data.access_token);
        setInstanceUrl(data.instance_url);

        const userRes = await fetch(
          `${PROXY_URL}/sfapi/services/oauth2/userinfo`,
          {
            headers: {
              Authorization: `Bearer ${data.access_token}`,
              "x-instance-url": data.instance_url,
            },
          },
        );
        const userInfo = await userRes.json();
        const uname = userInfo.preferred_username || userInfo.email || "";
        const org = data.instance_url || "";
        localStorage.setItem("sf_username", uname);
        localStorage.setItem("sf_org", org);
        setUsername(uname);
        setOrgName(org);
        setMessage("Connected to Salesforce successfully.");
      } else {
        setMessage("Authentication failed: " + JSON.stringify(data));
      }
    } catch (err) {
      setMessage("Error: " + err.message);
    }
  };

  const getValidationRules = async () => {
    setLoading(true);
    setMessage("");
    try {
      const query = `SELECT Id, ValidationName, Active, ErrorMessage FROM ValidationRule WHERE EntityDefinition.QualifiedApiName = 'Account'`;
      const res = await fetch(
        `${PROXY_URL}/sfapi/services/data/v59.0/tooling/query?q=${encodeURIComponent(query)}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "x-instance-url": instanceUrl,
          },
        },
      );
      const data = await res.json();
      if (data.records) {
        setValidationRules(data.records);
        setMessage(
          `Fetched ${data.records.length} validation rules from Salesforce.`,
        );
      } else {
        setMessage("Failed to fetch: " + JSON.stringify(data));
      }
    } catch (err) {
      setMessage("Error: " + err.message);
    }
    setLoading(false);
  };

  const toggleRule = (id) => {
    setValidationRules((prev) =>
      prev.map((r) => (r.Id === id ? { ...r, Active: !r.Active } : r)),
    );
  };

  const toggleAll = (val) => {
    setValidationRules((prev) => prev.map((r) => ({ ...r, Active: val })));
  };

  const deployChanges = async () => {
    try {
      setLoading(true);
      setMessage("Deploying changes...");
      let successCount = 0;
      let failCount = 0;

      for (const rule of validationRules) {
        try {
          // Step 1: Existing metadata fetch karo PROXY se
          const getResponse = await fetch(
            `${PROXY_URL}/sfapi/services/data/v59.0/tooling/sobjects/ValidationRule/${rule.Id}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "x-instance-url": instanceUrl,
              },
            },
          );
          const existingRule = await getResponse.json();

          if (!existingRule.Metadata) {
            console.error(
              `No metadata for rule ${rule.ValidationName}:`,
              existingRule,
            );
            failCount++;
            continue;
          }

          // Step 2: Metadata merge karo
          const updatedMetadata = {
            ...existingRule.Metadata,
            active: rule.Active,
          };

          // Step 3: PATCH request PROXY se bhejo
          const patchResponse = await fetch(
            `${PROXY_URL}/sfapi/services/data/v59.0/tooling/sobjects/ValidationRule/${rule.Id}`,
            {
              method: "PATCH",
              headers: {
                Authorization: `Bearer ${accessToken}`,
                "Content-Type": "application/json",
                "x-instance-url": instanceUrl,
              },
              body: JSON.stringify({ Metadata: updatedMetadata }),
            },
          );

          if (patchResponse.ok || patchResponse.status === 204) {
            successCount++;
          } else {
            const errData = await patchResponse.json();
            console.error(`Rule ${rule.ValidationName} failed:`, errData);
            failCount++;
          }
        } catch (ruleErr) {
          console.error(`Rule ${rule.ValidationName} error:`, ruleErr);
          failCount++;
        }
      }

      if (failCount === 0) {
        setMessage(
          `✅ All ${successCount} rules successfully deployed to Salesforce!`,
        );
      } else {
        setMessage(
          `⚠️ ${successCount} deployed, ${failCount} failed. Check console (F12) for details.`,
        );
      }

      // Refresh karo deploy ke baad
      await getValidationRules();
    } catch (err) {
      setMessage("❌ Deploy failed: " + err.message);
    } finally {
      setLoading(false);
    }
  };

  const logout = () => {
    localStorage.clear();
    sessionStorage.clear();
    setAccessToken(null);
    setInstanceUrl(null);
    setValidationRules([]);
    setMessage("");
    setUsername("");
    setOrgName("");
  };

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo-icon">⚡</div>
          <h1>Validation Rules Manager</h1>
          <span className="header-badge">SALESFORCE</span>
        </div>

        {accessToken && (
          <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
            {username && (
              <div style={{ textAlign: "right" }}>
                <div
                  style={{
                    fontSize: "0.8rem",
                    color: "var(--text-dim)",
                    fontFamily: "JetBrains Mono, monospace",
                  }}
                >
                  👤 {username}
                </div>
                <div style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}>
                  {orgName}
                </div>
              </div>
            )}
            <button className="btn btn-logout" onClick={logout}>
              Sign out
            </button>
          </div>
        )}
      </header>

      <div className="container">
        {!accessToken ? (
          <div className="login-box">
            <div className="login-card">
              <div className="login-icon">☁️</div>
              <h2>Connect to Salesforce</h2>
              <p>
                Manage your Account object validation rules — activate,
                deactivate, and deploy changes directly from here.
              </p>
              <button className="btn btn-login" onClick={loginWithSalesforce}>
                🔐 Login with Salesforce
              </button>
            </div>
          </div>
        ) : (
          <div>
            <div className="action-bar">
              <button
                className="btn btn-primary"
                onClick={getValidationRules}
                disabled={loading}
              >
                📋 Fetch Rules
              </button>
              {validationRules.length > 0 && (
                <>
                  <div className="action-bar-divider" />
                  <button
                    className="btn btn-success"
                    onClick={() => toggleAll(true)}
                    disabled={loading}
                  >
                    ✅ Enable All
                  </button>
                  <button
                    className="btn btn-warning"
                    onClick={() => toggleAll(false)}
                    disabled={loading}
                  >
                    ✕ Disable All
                  </button>
                  <div className="action-bar-divider" />
                  <button
                    className="btn btn-deploy"
                    onClick={deployChanges}
                    disabled={loading}
                  >
                    🚀 Deploy to Salesforce
                  </button>
                </>
              )}
            </div>

            {message && <div className="message">ℹ️ {message}</div>}

            {loading && (
              <div className="loading">
                <div className="spinner" />
                Processing...
              </div>
            )}

            {validationRules.length > 0 && (
              <div>
                <div className="rules-header">
                  <span className="rules-title">Validation Rules</span>
                  <span className="rules-count">
                    {validationRules.length} rules
                  </span>
                </div>
                {validationRules.map((rule, i) => (
                  <div
                    key={rule.Id}
                    className={`rule-card ${rule.Active ? "active" : "inactive"}`}
                  >
                    <div className="rule-left">
                      <span className="rule-index">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                      <div className="rule-info">
                        <h3>{rule.ValidationName}</h3>
                        <p>{rule.ErrorMessage}</p>
                      </div>
                    </div>
                    <div className="rule-right">
                      <span
                        className={`badge ${rule.Active ? "badge-active" : "badge-inactive"}`}
                      >
                        {rule.Active ? "● Active" : "○ Inactive"}
                      </span>
                      <button
                        className={`toggle-btn ${rule.Active ? "active-toggle" : ""}`}
                        onClick={() => toggleRule(rule.Id)}
                      >
                        {rule.Active ? "Disable" : "Enable"}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
