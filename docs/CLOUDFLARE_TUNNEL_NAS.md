# Cloudflare Tunnel to NAS – detailed setup

Expose only the Synology File Station API through a Cloudflare Tunnel so your Render-hosted API can stream music from your NAS. No port forwarding; the NAS is never directly on the internet.

---

## Part A: Cloudflare – create and configure the tunnel

### A.1. Open Cloudflare Zero Trust

1. Go to **[Cloudflare One](https://one.dash.cloudflare.com/)** (Zero Trust dashboard).
2. Sign in with your Cloudflare account.
3. Select your **team** (or create one; the free tier is enough).

### A.2. Create the tunnel

1. In the left sidebar: **Networks** → **Connectors** → **Cloudflare Tunnels** (or **Networks** → **Tunnels** in some layouts).
2. Click **Create a tunnel** (or **Add a tunnel**).
3. **Connector type:** choose **Cloudflared** → **Next**.
4. **Tunnel name:** e.g. `nas-filestation` (only you see this). Click **Save tunnel**.
5. You are taken to the **Install connector** screen. Do **not** close this page.

### A.3. Get the tunnel token

On the same **Install connector** page:

1. Under **Choose an environment**, select the OS where the connector will run:
   - For **Synology (Linux)**: choose **Linux** (or the architecture that matches your NAS if listed).
   - For **Docker**: choose **Docker**.
2. A **install command** is shown in a code block. It looks like:
   ```bash
   cloudflared service install <LONG_TOKEN_STRING>
   ```
   or (newer UI):
   ```bash
   cloudflared tunnel run --token <LONG_TOKEN_STRING>
   ```
3. **Copy the entire token** — the long string after `install` or after `--token`. Save it somewhere safe; you will use it on the NAS. You need only the token, not the full command, if you configure the SynoCommunity package or a custom script.

You can leave the tunnel page open. The connector will show as **Connected** only after cloudflared is running with this token (Part B). Next, add the **public hostname** (Part A.4) so that once the connector is up, traffic is routed immediately.

### A.4. Add a public hostname (route traffic to the NAS)

Still in the tunnel’s page in Zero Trust:

1. Open the **Public Hostname** tab (or **Configure** → **Public Hostname**).
2. Click **Add a public hostname** (or **Add hostname**).
3. Fill in:
   - **Subdomain:** e.g. `nas` or `nas-download` (you will get `nas.yourdomain.com`).
   - **Domain:** choose your domain from the dropdown (e.g. **integrationfactor.com**). The domain must already be on Cloudflare (DNS managed by Cloudflare).
   - **Service type:** **HTTP**.
   - **URL:**  
     - If cloudflared runs **on the NAS**: `http://127.0.0.1:5000`  
     - If cloudflared runs on **another machine** on the LAN: `http://NAS_IP:5000` (e.g. `http://192.168.1.181:5000`).  
     Port **5000** is the default for Synology DSM/File Station HTTP.
4. Click **Save hostname**.

No need to open port 5000 on your router; Cloudflare will reach the NAS through the tunnel once the connector is running.

### A.5. (Optional) Additional application settings

If you need timeouts or other options, expand **Additional application settings** and set [origin parameters](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/configure-tunnels/origin-configuration/) (e.g. connect timeout). For File Station streaming, defaults are usually fine.

---

## Part B: Run the connector on the NAS (cloudflared)

You must run cloudflared with the **tunnel token** from A.3. Two practical options:

### B.1. Option 1 – SynoCommunity package (recommended if available)

The [SynoCommunity Cloudflare Tunnel (cloudflared)](https://synocommunity.com/package/cloudflared) package runs cloudflared as a native DSM service.

**Step 1: Add SynoCommunity**

1. DSM → **Package Center** → **Settings** → **Package Sources**.
2. Click **Add**.
3. **Name:** `SynoCommunity`
4. **Location:** `https://packages.synocommunity.com`
5. **OK**.

**Step 2: Install the package**

1. In **Package Center**, ensure the **SynoCommunity** source is selected or search **All**.
2. Search for **Cloudflared** or **Cloudflare Tunnel**.
3. Click **Install** and wait for installation to finish.

**Step 3: Configure the tunnel token**

The SynoCommunity package does not always expose a GUI for the token. Use one of these:

- **If the package has a UI:** Open the package from the DSM desktop or **Package Center** → **Installed** → **Cloudflare Tunnel** (or similar). Look for a field like **Tunnel token** or **Token** and paste the token from A.3. Save and start the service.
- **If there is no token field:** The package may expect a config file or environment variable. Check the package’s **Help** in Package Center. Alternatively, use **Option 2 (Docker)** below, which always accepts the token in the run command.

**Step 4: Start and autostart**

1. In **Package Center** → **Installed**, find **Cloudflare Tunnel** / **Cloudflared**.
2. Click **Run** if it is not running.
3. Open the package and enable **Run at startup** / **Autostart** if available.

**Step 5: Verify**

In Cloudflare Zero Trust → **Networks** → **Connectors** → **Cloudflare Tunnels** → your tunnel, the connector should show **Healthy** / **Connected** within a minute or two.

### B.2. Option 2 – Docker on Synology

If the SynoCommunity package is not available for your model or you prefer Docker:

1. **Package Center** → install **Container Manager** (Docker).
2. Open **Container Manager** → **Registry** → search **cloudflare/cloudflared** → **Download** (latest).
3. **Image** → select **cloudflare/cloudflared** → **Launch**.
4. **General settings:** give the container a name (e.g. `cloudflared`).
5. **Advanced settings**:
   - **Enable auto-restart:** Yes.
   - **Execution command** (or **Command**):  
     `tunnel run --token YOUR_TUNNEL_TOKEN`  
     Replace `YOUR_TUNNEL_TOKEN` with the exact token from A.3 (no quotes in the UI).
6. **Network:** Use **bridge** or **host** as needed; for `http://127.0.0.1:5000` use host so the container sees the NAS’s own port 5000.
7. Create and **Start** the container.
8. In Zero Trust → **Tunnels**, the connector should show **Connected**.

### B.3. Option 3 – Another machine on the same LAN

On a Linux/Mac/Windows machine or Raspberry Pi that can reach the NAS:

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation/) for your OS.
2. Run:
   ```bash
   cloudflared tunnel run --token YOUR_TUNNEL_TOKEN
   ```
3. In A.4, set **URL** to `http://NAS_IP:5000` (e.g. `http://192.168.1.181:5000`).

---

## Part C: Restrict access with Cloudflare Access (service token)

So that **only your Render API** can use the tunnel (no public access):

### C.1. Create a service token

1. In Cloudflare Zero Trust: **Access** → **Service credentials** (or **Access controls** → **Service credentials**) → **Service Tokens**.
2. Click **Create Service Token**.
3. **Name:** e.g. `render-api`.
4. **Service Token Duration:** e.g. 1 year or as needed.
5. Click **Generate token** (or **Create Service Token**).
6. **Copy and store the Client ID and Client Secret immediately.** The secret is shown only once. You will use these in Render as `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

### C.2. Create an Access application for the tunnel hostname

1. **Access** → **Applications** → **Add an application**.
2. **Application type:** **Self-hosted**.
3. **Application name:** e.g. `NAS File Station (tunnel)`.
4. **Session Duration:** default or as you prefer.
5. **Application domain:**
   - **Subdomain:** the same subdomain you used in A.4 (e.g. `nas`).
   - **Domain:** same domain (e.g. **integrationfactor.com**).  
   So the application domain is exactly the hostname you use for the tunnel (e.g. `nas.integrationfactor.com`).
6. Click **Next** or **Save**.

### C.3. Add a policy that allows only the service token

1. On the **Policies** step (or **Add a policy** for this application):
2. **Policy name:** e.g. `Render API only`.
3. **Action:** **Allow**.
4. **Configure rules** → **Include** → choose **Service Token**.
5. Select the service token you created in C.1 (e.g. `render-api`).
6. Save the policy and the application.

Result: Only requests that send the headers `CF-Access-Client-Id` and `CF-Access-Client-Secret` with the correct values will reach the NAS. Your Render API will send these; browsers without the token will get an Access denial.

---

## Part D: Configure the Media Server (Render)

In **Render** → your API service → **Environment**:

| Variable | Value |
|----------|--------|
| **NAS_TUNNEL_URL** | `https://nas.integrationfactor.com` (no trailing slash; use the hostname you set in A.4) |
| **CF_ACCESS_CLIENT_ID** | Client ID from C.1 |
| **CF_ACCESS_CLIENT_SECRET** | Client Secret from C.1 |

Keep **NAS_USER** and **NAS_PASS** (and optionally **NAS_HOST** / **NAS_PORT** for local use). The server uses the tunnel URL when **NAS_TUNNEL_URL** is set and sends the Cloudflare Access headers automatically.

Redeploy the service after changing environment variables.

---

## Part E: Test

From your machine (with the token values):

```bash
curl -I -H "CF-Access-Client-Id: YOUR_CLIENT_ID" -H "CF-Access-Client-Secret: YOUR_CLIENT_SECRET" "https://nas.integrationfactor.com/webapi/entry.cgi?api=SYNO.API.Info&version=1&method=query"
```

- With correct headers: you should get **200** or a Synology JSON response.
- Without the headers: **403** (Access denied).

---

## Troubleshooting: Connector not showing in Cloudflare

If the cloudflared package is running on the NAS but the connector never appears (or stays Inactive) in Zero Trust → Tunnels:

### 1. The package may not be using your token

Many SynoCommunity packages start cloudflared **without** the tunnel token unless you configured it. So the process runs but never registers with Cloudflare.

**Check what’s actually running (SSH):**

```bash
# On the NAS via SSH (enable SSH in DSM: Control Panel → Terminal & SNMP)
ps aux | grep cloudflared
```

- If you see `cloudflared tunnel run --token eyJ...` (or similar), the token is in use.
- If you see only `cloudflared` with no `--token`, or a different command, the package is **not** using your token.

**Fix:** Configure the token in the package’s UI (if it has a token field), or switch to **Docker** and run with:

`tunnel run --token YOUR_TUNNEL_TOKEN`

so the token is guaranteed to be used.

### 2. Test the token manually (SSH)

From the NAS (or any machine that can reach the internet), run cloudflared once by hand to confirm the token works and Cloudflare sees the connector:

```bash
# If cloudflared is installed (e.g. SynoCommunity package), from SSH on the NAS:
/var/packages/cloudflared/target/bin/cloudflared tunnel run --token YOUR_FULL_TOKEN
```

(If the binary is elsewhere, use `which cloudflared` or check the package’s install path.)

- If the connector appears in Cloudflare within a minute, the token and network are fine; the issue is how the **package** starts cloudflared (see step 1).
- If you see errors (e.g. timeout, connection refused), see step 3.

### 3. Outbound port 7844 blocked

Cloudflared talks to Cloudflare over **port 7844** (TCP/UDP). If your NAS or router blocks outbound 7844, the connector will never register.

- **Router/firewall:** Allow outbound TCP and UDP to port **7844** (destination: any, or Cloudflare IPs if you restrict).
- **NAS firewall:** If you enabled DSM’s firewall, allow the cloudflared package (or “all” for testing) outbound.

Quick test from the NAS (SSH):

```bash
nc -zv 162.159.192.1 7844
# or
curl -v --connect-timeout 5 https://region1.v2.argotunnel.com
```

If these fail, 7844 or HTTPS to Cloudflare is blocked.

### 4. Regenerate the tunnel token

Tokens can be invalid if the tunnel was recreated or the token was copied incorrectly.

1. Zero Trust → **Networks** → **Connectors** → **Cloudflare Tunnels** → open your tunnel.
2. Open the **Install connector** (or **Connectors**) tab.
3. Use **Reinstall** / **Regenerate token** (or create a new connector and copy the new token).
4. Update the NAS: paste the **new** token into the package config or Docker run command and restart the connector.

### 5. Check package logs

If the package writes logs, look for cloudflared errors:

- **Package Center** → your package → **Log** (if available).
- Or via SSH: `cat /var/log/cloudflared.log` or under `/var/packages/cloudflared/var/` (paths vary by package).

Errors like “connection refused”, “timeout”, or “unauthorized” point to network or token issues.

---

## Summary

| Step | Where | What |
|------|--------|------|
| A | Cloudflare Zero Trust | Create tunnel → copy token → add Public Hostname (subdomain + domain, HTTP, `http://127.0.0.1:5000` or `http://NAS_IP:5000`) |
| B | Synology (or Docker / other machine) | Run cloudflared with `tunnel run --token TOKEN` (package or Docker or CLI) |
| C | Cloudflare Zero Trust | Create Service Token → create Access application for tunnel hostname → add Allow policy with that Service Token |
| D | Render | Set NAS_TUNNEL_URL, CF_ACCESS_CLIENT_ID, CF_ACCESS_CLIENT_SECRET |
| E | Your machine | Test with `curl` and the two headers |

References:

- [Create a tunnel (dashboard)](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/)
- [Service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
- [SynoCommunity – Cloudflare Tunnel](https://synocommunity.com/package/cloudflared)
