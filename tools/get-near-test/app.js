import * as h from "./helpers.mjs";

const $ = (id) => document.getElementById(id);
const NEAR_RPCS = ["https://free.rpc.fastnear.com", "https://near.drpc.org"];
const STORE_KEY = "get-near-test.pending";
const BASE = { chainId: "0x2105", chainName: "Base", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: ["https://mainnet.base.org"], blockExplorerUrls: ["https://basescan.org"] };

const st = { providers: new Map(), provider: null, account: null, dest: null, tokens: null, connecting: false,
  amount: null, recipient: null, real: null, before: null, sending: false };

// ---------- log ----------
const logLines = [];
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  logLines.push(line);
  $("log").textContent = logLines.join("\n");
  $("log").scrollTop = 1e9;
}
$("btnCopy").onclick = async () => {
  try { await navigator.clipboard.writeText(logLines.join("\n")); log("log copied"); } catch { log("copy failed; select the text manually"); }
};

// ---------- DOM helpers (textContent only) ----------
function msg(el, cls, text) { el.replaceChildren(); const d = document.createElement("div"); d.className = cls; d.textContent = text; el.append(d); }
function table(el, rows) {
  const t = document.createElement("table");
  for (const [k, v] of rows) {
    const tr = t.insertRow(); tr.insertCell().textContent = k;
    const c = tr.insertCell();
    if (v instanceof Node) c.append(v); else c.textContent = v;
  }
  el.append(t);
}
const link = (href, text) => { const a = document.createElement("a"); a.href = href; a.textContent = text; a.target = "_blank"; a.rel = "noopener noreferrer"; return a; };

// ---------- API (through local proxy) ----------
async function api(path, init) {
  const res = await fetch(path, init);
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}: ${text.slice(0, 400)}`);
  if (json === null) throw new Error(`Non-JSON from ${path}: ${text.slice(0, 200)}`);
  return json;
}
const post = (path, body) => api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

// ---------- wallet discovery (EIP-6963) ----------
window.addEventListener("eip6963:announceProvider", (e) => {
  const { info, provider } = e.detail ?? {};
  if (!info?.uuid || !provider || st.providers.has(info.uuid)) return;
  st.providers.set(info.uuid, { info, provider });
  renderWallets();
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
setTimeout(() => {
  if (st.providers.size === 0 && window.ethereum) {
    st.providers.set("window.ethereum", { info: { uuid: "window.ethereum", name: "Browser wallet (window.ethereum fallback)" }, provider: window.ethereum });
    log("no EIP-6963 wallet announced; using window.ethereum fallback");
  }
  renderWallets();
}, 800);

function renderWallets() {
  const el = $("wallets"); el.replaceChildren();
  if (st.providers.size === 0) { el.textContent = "No wallet detected yet (install/enable Rabby or MetaMask, then reload)."; return; }
  for (const [id, { info }] of st.providers) {
    const b = document.createElement("button");
    b.textContent = `Connect ${info.name}`;
    b.onclick = () => connect(id);
    el.append(b);
  }
}

function connect(id) {
  if (st.connecting) return;
  st.connecting = true;
  const entry = st.providers.get(id);
  // eth_requestAccounts is called directly in the click handler, with nothing awaited before it.
  const p = entry.provider.request({ method: "eth_requestAccounts" });
  (async () => {
    try {
      const accounts = await p;
      if (!accounts?.[0]) throw new Error("wallet returned no account");
      st.provider = entry.provider; st.account = accounts[0];
      log(`connected ${entry.info.name} ${st.account}`);
      await ensureBase();
      st.provider.on?.("accountsChanged", () => { log("account changed: reload the page"); msg($("walletStatus"), "err", "Account changed in the wallet. Reload this page."); });
      st.provider.on?.("chainChanged", () => log("chain changed"));
      msg($("walletStatus"), "ok", `Connected: ${st.account} on Base`);
      await refreshBalance();
    } catch (err) { walletError(err, $("walletStatus")); }
    finally { st.connecting = false; refreshButtons(); }
  })();
}

function walletError(err, el) {
  log(`wallet error: ${err?.code ?? ""} ${err?.message ?? err}`);
  if (h.isPendingWalletError(err)) msg(el, "warn", h.PENDING_MESSAGE);
  else if (err?.code === 4001) msg(el, "err", "Request rejected in the wallet.");
  else msg(el, "err", `Wallet error: ${err?.message ?? err}`);
}

async function ensureBase() {
  const chain = await st.provider.request({ method: "eth_chainId" });
  if (parseInt(chain, 16) === 8453) return;
  try {
    await st.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE.chainId }] });
  } catch (err) {
    if (err?.code !== 4902) throw err;
    await st.provider.request({ method: "wallet_addEthereumChain", params: [BASE] });
  }
  const after = await st.provider.request({ method: "eth_chainId" });
  if (parseInt(after, 16) !== 8453) throw new Error("wallet is not on Base (8453)");
}

async function refreshBalance() {
  try {
    const out = await st.provider.request({ method: "eth_call", params: [{ to: h.BASE_USDC, data: h.encodeBalanceOf(st.account) }, "latest"] });
    st.usdcBalance = BigInt(out);
    $("balanceBox").textContent = `Base USDC balance: ${h.formatUnits(st.usdcBalance, 6)} USDC`;
    log(`USDC balance ${h.formatUnits(st.usdcBalance, 6)}`);
  } catch (err) { st.usdcBalance = null; $("balanceBox").textContent = "Could not read USDC balance."; log(`balance error ${err?.message}`); }
}

// ---------- inputs ----------
function readInputs() {
  let amount;
  try { amount = h.parseUnits($("amount").value, 6); } catch (e) { return { error: e.message }; }
  if (amount < h.parseUnits(h.MIN_USDC, 6)) return { error: `Minimum is ${h.MIN_USDC} USDC` };
  if (amount > h.parseUnits(h.MAX_USDC, 6)) return { error: `Hard cap is ${h.MAX_USDC} USDC` };
  const recipient = $("recipient").value.trim();
  if (!h.isNearAccountId(recipient)) return { error: "Recipient is not a valid NEAR account id" };
  if (!st.account) return { error: "Connect a wallet first" };
  if (st.usdcBalance != null && st.usdcBalance < amount) return { error: `Insufficient Base USDC: have ${h.formatUnits(st.usdcBalance, 6)}` };
  return { amount, recipient };
}
function updateConfirm() {
  const r = readInputs();
  const box = $("confirmBox");
  if (r.error) { box.textContent = r.error; return; }
  box.textContent = `You will spend ${h.formatUnits(r.amount, 6)} USDC from ${st.account} on Base, delivered to NEAR account "${r.recipient}".`;
}
$("amount").oninput = $("recipient").oninput = () => { st.real = null; $("chk").checked = false; updateConfirm(); refreshButtons(); };

function refreshButtons() {
  const ok = !readInputs().error && !st.connecting;
  $("btnDry").disabled = !ok;
  $("btnReal").disabled = !ok || !st.dest;
  $("chk").disabled = !st.real;
  $("btnSend").disabled = !(st.real && $("chk").checked && !st.sending);
  $("btnRecheck").disabled = !loadPending();
  $("btnResume").disabled = !loadPending();
  updateConfirm();
}
$("chk").onchange = refreshButtons;

// ---------- destination asset ----------
async function loadDest() {
  try {
    st.tokens = await api("/api/tokens");
    st.dest = h.chooseNearDestination(st.tokens);
  } catch (err) {
    log(`token list failed: ${err.message}`);
    st.dest = h.chooseNearDestination([]);
  }
  log(`destination asset: ${st.dest.assetId} (${st.dest.symbol}, ${st.dest.decimals}dp, native=${st.dest.native})`);
  refreshButtons();
}

// ---------- quotes ----------
function quoteBody(dry, r) {
  return {
    dry, swapType: "EXACT_INPUT", slippageTolerance: 100,
    originAsset: h.ORIGIN_ASSET, destinationAsset: st.dest.assetId,
    amount: r.amount.toString(), recipient: r.recipient, recipientType: "DESTINATION_CHAIN",
    refundTo: st.account, refundType: "ORIGIN_CHAIN", depositType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
  };
}
function showQuote(el, resp, dry) {
  const q = resp.quote, d = st.dest.decimals;
  table(el, [
    ["Destination asset", resp.quoteRequest?.destinationAsset ?? "?"],
    ["Amount in", `${h.formatUnits(q.amountIn, 6)} USDC (${q.amountIn})`],
    ["Amount out", `${h.formatUnits(q.amountOut, d, 8)} ${st.dest.symbol}`],
    ["Minimum out", `${h.formatUnits(q.minAmountOut, d, 8)} ${st.dest.symbol}`],
    ["Recipient", resp.quoteRequest?.recipient ?? "?"],
    ["Refund to", resp.quoteRequest?.refundTo ?? "?"],
    ...(dry ? [] : [["Deposit address", q.depositAddress ?? "?"], ["Deadline", q.deadline ?? "?"]]),
    ["Time estimate", `${q.timeEstimate ?? "?"} s`],
  ]);
}
const wrapWarning = () => st.dest.native ? null : "This will arrive as wNEAR (a token), not spendable NEAR. You must unwrap it.";

$("btnDry").onclick = async () => {
  const r = readInputs(); if (r.error) return;
  $("btnDry").disabled = true; $("dryOut").replaceChildren();
  try {
    log("dry quote requested");
    const resp = await post("/api/quote", quoteBody(true, r));
    log(`dry quote: amountOut=${resp.quote?.amountOut} min=${resp.quote?.minAmountOut}`);
    showQuote($("dryOut"), resp, true);
    const w = wrapWarning(); if (w) $("dryOut").prepend(Object.assign(document.createElement("div"), { className: "warn", textContent: w }));
  } catch (err) { msg($("dryOut"), "err", err.message); log(`dry error ${err.message}`); }
  finally { refreshButtons(); }
};

$("btnReal").onclick = async () => {
  const r = readInputs(); if (r.error) return;
  $("btnReal").disabled = true; st.real = null; $("chk").checked = false; $("realOut").replaceChildren();
  try {
    log("real quote requested");
    const resp = await post("/api/quote", quoteBody(false, r));
    log(`real quote: ${JSON.stringify(resp.quote)}`);
    const problems = h.checkQuote(resp, {
      recipient: r.recipient, refundTo: st.account, originAsset: h.ORIGIN_ASSET,
      destinationAsset: st.dest.assetId, amount: r.amount.toString(), usdc: h.BASE_USDC,
    });
    if (problems.length) {
      msg($("realOut"), "err", "QUOTE REJECTED. Do not send. " + problems.join("; "));
      log(`quote checks FAILED: ${problems.join("; ")}`);
      return;
    }
    log("quote checks passed");
    st.real = { resp, amount: r.amount, recipient: r.recipient, depositAddress: resp.quote.depositAddress };
    st.amount = r.amount; st.recipient = r.recipient;
    showQuote($("realOut"), resp, false);
    const w = wrapWarning(); if (w) $("realOut").prepend(Object.assign(document.createElement("div"), { className: "warn", textContent: w }));
    $("realOut").prepend(Object.assign(document.createElement("div"), { className: "ok", textContent: "All safety checks passed. Review every field, then tick the box." }));
  } catch (err) { msg($("realOut"), "err", err.message); log(`real quote error ${err.message}`); }
  finally { refreshButtons(); }
};

// ---------- NEAR RPC ----------
async function nearRpc(params, method = "query") {
  let last;
  for (const url of NEAR_RPCS) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "x", method, params }), signal: AbortSignal.timeout(15000) });
      const j = await res.json();
      if (j.error) {
        const s = JSON.stringify(j.error);
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(s)) return { unknownAccount: true };
        throw new Error(s.slice(0, 300));
      }
      return j.result;
    } catch (err) { last = err; log(`NEAR RPC ${url} failed: ${err.message}`); }
  }
  throw last;
}
async function nearBalances(account) {
  const acc = await nearRpc({ request_type: "view_account", finality: "final", account_id: account });
  const native = acc.unknownAccount ? 0n : BigInt(acc.amount);
  const args = btoa(JSON.stringify({ account_id: account }));
  const ft = await nearRpc({ request_type: "call_function", finality: "final", account_id: "wrap.near", method_name: "ft_balance_of", args_base64: args });
  return { native, wnear: h.decodeCallResult(ft), unknown: !!acc.unknownAccount };
}

// ---------- send ----------
$("btnSend").onclick = async () => {
  if (!st.real || st.sending) return;
  const { depositAddress, amount, recipient } = st.real;
  st.sending = true; refreshButtons(); $("sendOut").replaceChildren();
  try {
    await ensureBase();
    await refreshBalance();
    if (st.usdcBalance != null && st.usdcBalance < amount) throw new Error("Insufficient USDC now");
    msg($("sendOut"), "warn", "Reading NEAR balances before sending...");
    const before = await nearBalances(recipient);
    st.before = before;
    log(`BEFORE native=${before.native} wnear=${before.wnear}`);
    const data = h.encodeErc20Transfer(depositAddress, amount);
    log(`sending transfer(${depositAddress}, ${amount}) to USDC contract`);
    msg($("sendOut"), "warn", "Approve the transfer in your wallet...");
    const txHash = await st.provider.request({ method: "eth_sendTransaction", params: [{ from: st.account, to: h.BASE_USDC, data }] });
    log(`tx hash ${txHash}`);
    savePending({ depositAddress, txHash, recipient, amount: amount.toString(), destAsset: st.dest.assetId, destSymbol: st.dest.symbol,
      destDecimals: st.dest.decimals, before: { native: before.native.toString(), wnear: before.wnear.toString() } });
    msg($("sendOut"), "ok", "Sent. Tx: ");
    $("sendOut").firstChild.append(link(`https://basescan.org/tx/${txHash}`, txHash));
    try { log(`deposit-submit: ${JSON.stringify(await post("/api/deposit-submit", { txHash, depositAddress }))}`); }
    catch (err) { log(`deposit-submit failed (polling continues): ${err.message}`); }
    poll(loadPending());
  } catch (err) { walletError(err, $("sendOut")); }
  finally { st.sending = false; refreshButtons(); }
};

// ---------- persistence + polling ----------
function savePending(p) { try { localStorage.setItem(STORE_KEY, JSON.stringify(p)); } catch { /* ignore */ } }
function loadPending() { try { return JSON.parse(localStorage.getItem(STORE_KEY) ?? "null"); } catch { return null; } }
$("btnClear").onclick = () => { try { localStorage.removeItem(STORE_KEY); } catch { /* ignore */ } log("saved swap cleared"); refreshButtons(); };
$("btnResume").onclick = () => { const p = loadPending(); if (p) poll(p); };
$("btnRecheck").onclick = () => { const p = loadPending(); if (p) verify(p); };

let pollToken = 0;
async function poll(p) {
  if (!p) return;
  const my = ++pollToken;
  const el = $("verifyOut");
  const start = Date.now();
  log(`polling status for ${p.depositAddress}`);
  while (my === pollToken && Date.now() - start < 10 * 60_000) {
    try {
      const s = await api(`/api/status?depositAddress=${encodeURIComponent(p.depositAddress)}`);
      el.replaceChildren();
      const rows = [["State", s.status], ["Updated", s.updatedAt ?? ""]];
      for (const t of s.swapDetails?.destinationChainTxHashes ?? []) rows.push(["Destination tx", t.explorerUrl ? link(t.explorerUrl, t.hash) : t.hash]);
      for (const t of s.swapDetails?.originChainTxHashes ?? []) rows.push(["Origin tx", t.explorerUrl ? link(t.explorerUrl, t.hash) : t.hash]);
      for (const t of s.swapDetails?.nearTxHashes ?? []) rows.push(["NEAR tx", link(`https://nearblocks.io/txns/${t}`, t)]);
      if (s.swapDetails?.refundReason) rows.push(["Refund reason", s.swapDetails.refundReason]);
      table(el, rows);
      log(`status ${s.status}`);
      if (s.status === "SUCCESS") { await verify(p); return; }
      if (["REFUNDED", "FAILED"].includes(s.status)) { el.prepend(Object.assign(document.createElement("div"), { className: "err", textContent: `Swap ended: ${s.status}. Funds go back to the refund address.` })); return; }
    } catch (err) { log(`status error ${err.message}`); }
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (my === pollToken) log("polling stopped after 10 minutes; use Resume to continue");
}

async function verify(p) {
  const el = $("verifyOut");
  try {
    const before = { native: BigInt(p.before.native), wnear: BigInt(p.before.wnear) };
    const after = await nearBalances(p.recipient);
    log(`AFTER native=${after.native} wnear=${after.wnear}`);
    const v = h.verdict(before, after);
    const f = (x) => h.formatUnits(x, 24, 8);
    const box = document.createElement("div");
    table(box, [
      ["Native NEAR before", `${f(before.native)} NEAR`], ["Native NEAR after", `${f(after.native)} NEAR`],
      ["wNEAR before", `${f(before.wnear)} wNEAR`], ["wNEAR after", `${f(after.wnear)} wNEAR`],
    ]);
    const verdictEl = Object.assign(document.createElement("div"), { className: v.kind === "native" ? "ok" : v.kind === "wnear" ? "warn" : "err", textContent: v.text });
    verdictEl.style.fontWeight = "bold";
    el.append(verdictEl, box);
    log(`VERDICT: ${v.text}`);
    if (v.kind === "wnear") showUnwrap(after.wnear - before.wnear, p.recipient);
  } catch (err) { msg(el, "err", `Could not read NEAR balances: ${err.message}`); log(`verify error ${err.message}`); }
}

function showUnwrap(amountYocto, recipient) {
  const el = $("unwrap"); el.replaceChildren();
  const box = document.createElement("div"); box.className = "warn";
  box.textContent =
    `Unwrap needed. ${recipient} must already hold at least 0.01 NEAR for gas. Manual steps: call contract wrap.near, method near_withdraw, ` +
    `args {"amount":"${amountYocto}"}, attached deposit exactly 1 yoctoNEAR, signed by ${recipient} (use a NEAR wallet or CLI that can call contracts). ` +
    "Meteor may have a built-in unwrap option (unverified). This tool does not sign NEAR transactions.";
  el.append(box);
}

// ---------- init ----------
updateConfirm();
loadDest();
refreshButtons();
if (loadPending()) log("found a saved swap: press Resume saved swap to continue polling");
