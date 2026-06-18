# Hub Impressao 1.8 Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Hub Impressao 1.8 with route-safe auto-printing, no cross-sector fallback, better duplicate prevention, Pedidos Hub contract alignment, and a cleaner local operator UI.

**Architecture:** Add a shared print-route normalizer in Hub Impressao and use it from settings, HTTP, WebSocket, and Supabase listener paths. Mirror the same attendance/kitchen model in Pedidos Hub helpers while keeping legacy `counter` and `delivery` payload keys for existing clients. Keep automatic routing strict only when an explicit `autoPrint` map exists; otherwise preserve legacy behavior.

**Tech Stack:** Electron main process, Express, WebSocket, Supabase Realtime, plain renderer HTML/CSS/JS, Node standalone tests, Pedidos Hub TypeScript/Vitest focused tests.

---

## File Structure

- Create `src/main/print-routes.js`: canonical route helpers for `kitchen`, `attendance`, legacy aliases, `autoPrint` normalization, and route-aware target building.
- Modify `src/main/config/settings.js`: use `print-routes.js` to persist `autoPrint.attendance` while preserving legacy `counter` and `delivery` keys.
- Modify `src/main/server.js`: use the shared resolver for automatic HTTP and local WebSocket print requests; never use `default` as cross-route fallback in routed mode.
- Modify `src/main/websocket/secure-server.js`: use the same resolver and bump handshake version to `1.8.0`.
- Modify `src/main/supabase/paired-print-listener.js`: route per-printer auto print by `kitchen` and `attendance`, ledger by those routes, fix WebSocket notification argument compatibility, and preserve legacy mode.
- Modify `src/preload.js`, `src/renderer/index.html`, `src/renderer/app.js`, `src/renderer/styles.css`: expose pairing/settings to renderer and simplify the UI status around auto-print ownership and printer roles.
- Modify `package.json`, `package-lock.json`, installer metadata where needed: set version `1.8.0`.
- Modify Pedidos Hub files:
  - `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos/src/utils/auto-print-routing.ts`
  - `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos/src/utils/local-printer-sync.ts`
  - `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos/src/hooks/usePrintJobListener.ts`
  - focused tests beside those files.

## Tasks

### Task 1: Hub route helper and settings compatibility

**Files:**
- Create: `src/main/print-routes.js`
- Test: `tests/print-routes.test.js`
- Modify: `src/main/config/settings.js`

- [ ] **Step 1: Write failing tests**

```js
const routes = require('../src/main/print-routes');

check('delivery normalizes to attendance', routes.normalizeAutoPrintRoute('delivery'), 'attendance');
check('counter normalizes to attendance', routes.normalizeAutoPrintRoute('counter'), 'attendance');
check('attendance map prefers attendance over legacy delivery/counter', routes.normalizeAutoPrintMap({
  kitchen: 'K',
  counter: 'C',
  delivery: 'D',
  attendance: 'A'
}), { kitchen: 'K', attendance: 'A', counter: 'A', delivery: 'A' });
```

- [ ] **Step 2: Run RED**

Run: `node tests/print-routes.test.js`  
Expected: FAIL because `src/main/print-routes.js` does not exist.

- [ ] **Step 3: Implement helper and settings usage**

Create `normalizeAutoPrintRoute`, `normalizeLegacyPrinterType`, `normalizeAutoPrintMap`, `getAutoPrintPrinterForRoute`, and `buildAutoPrintRoutesForOrder`. Update `settings.js` to call `normalizeAutoPrintMap`.

- [ ] **Step 4: Run GREEN**

Run: `node tests/print-routes.test.js`  
Expected: PASS.

### Task 2: Hub automatic routing safety in HTTP, WebSocket, and Supabase

**Files:**
- Test: `tests/auto-print-attendance-routing.test.js`
- Test: `tests/websocket-notify-order-id.test.js`
- Modify: `src/main/server.js`
- Modify: `src/main/websocket/secure-server.js`
- Modify: `src/main/supabase/paired-print-listener.js`

- [ ] **Step 1: Write failing tests**

```js
check('routed auto delivery uses attendance printer only', printed.map((job) => job.printer), ['Attendance']);
check('default printer is not cross-route fallback in routed mode', printed.some((job) => job.printer === 'Default'), false);
check('notify accepts old two-arg call and stores order id', listener.processingOrderIds.has('order-1'), true);
```

- [ ] **Step 2: Run RED**

Run: `node tests/auto-print-attendance-routing.test.js && node tests/websocket-notify-order-id.test.js`  
Expected: FAIL on missing attendance route behavior and two-argument notify compatibility.

- [ ] **Step 3: Implement routing**

Update automatic paths to use route-aware targets:

```js
const route = normalizeAutoPrintRoute(printType);
const autoTarget = resolveAutoPrintTarget(orderData, printType);
if (isAutoPrint && autoTarget.routedMode && !autoTarget.printer) skip;
```

In Supabase per-printer mode, build vias as `kitchen` and `attendance`, render attendance with `printType: 'counter'`, and claim ledger with `printer_type: 'attendance'`.

- [ ] **Step 4: Run GREEN**

Run: `node tests/auto-print-attendance-routing.test.js && node tests/websocket-notify-order-id.test.js`  
Expected: PASS.

### Task 3: Pedidos Hub contract alignment

**Files:**
- Modify: `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos/src/utils/auto-print-routing.ts`
- Modify: `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos/src/utils/local-printer-sync.ts`
- Modify: `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos/src/hooks/usePrintJobListener.ts`
- Test: existing focused Vitest files in `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos/src/utils`

- [ ] **Step 1: Write/update failing tests**

Update tests to expect `attendance` in `autoPrintRouting` while still accepting legacy `counter` and `delivery` keys for Hub compatibility.

- [ ] **Step 2: Run RED**

Run: `npx vitest run src/utils/auto-print-routing.exploration.test.ts src/utils/local-printer-sync.test.ts` from Pedidos Hub.  
Expected: FAIL until production helpers expose attendance.

- [ ] **Step 3: Implement Pedidos Hub changes**

Add `attendance` to the auto-print map, normalize delivery/counter to attendance for automatic dispatch, and keep browser fallback route-aware.

- [ ] **Step 4: Run GREEN**

Run focused Pedidos Hub print tests.  
Expected: PASS.

### Task 4: Hub UI cleanup and version 1.8.0

**Files:**
- Modify: `src/preload.js`
- Modify: `src/renderer/index.html`
- Modify: `src/renderer/app.js`
- Modify: `src/renderer/styles.css`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/main/websocket/secure-server.js`

- [ ] **Step 1: Write/update smoke tests**

Add version and static UI checks that assert `1.8.0`, attendance wording, and no stale `v1.7.0`.

- [ ] **Step 2: Run RED**

Run: `node tests/release-1-8-smoke.test.js`  
Expected: FAIL while package/UI/handshake still say `1.7.x`.

- [ ] **Step 3: Implement UI/version updates**

Expose `getPairingStatus` and `getSettings` through preload, render service status, paired store, ownership, route warnings, printer count, recent activity, and set all versions to `1.8.0`.

- [ ] **Step 4: Run GREEN**

Run: `node tests/release-1-8-smoke.test.js`  
Expected: PASS.

### Task 5: Final verification

**Files:**
- No new source files unless verification finds a defect.

- [ ] **Step 1: Run Hub focused tests**

Run:

```bash
node tests/print-routes.test.js
node tests/auto-print-attendance-routing.test.js
node tests/websocket-notify-order-id.test.js
node tests/auto-print-both-routing.test.js
node tests/accept-safety-net.test.js
node tests/offline-auto-print-skip.test.js
node tests/manual-print-http-defer.test.js
node tests/pairing-status.test.js
node tests/render-session-refresh.test.js
node tests/official-render-payload.test.js
node tests/win-spool-parser.test.js
node tests/release-1-8-smoke.test.js
```

- [ ] **Step 2: Run Pedidos Hub focused tests**

Run from Pedidos Hub:

```bash
npx vitest run src/utils/auto-print-routing.exploration.test.ts src/utils/local-printer-sync.test.ts src/utils/auto-print-policy.test.ts src/layouts/MainLayout.auto-print.test.ts src/utils/print-manager.test.ts src/components/OrderKanbanCard.print.test.ts
```

- [ ] **Step 3: Run build-level checks**

Run feasible build checks in both repositories and `git diff --check`.

- [ ] **Step 4: Review diff**

Confirm no unrelated files were reverted and list any pre-existing dirty files separately from release changes.

## Self-Review

- Spec coverage: the plan maps every design section to either routing, duplicate prevention, Pedidos Hub contract, UI/versioning, or verification.
- Placeholder scan: no task relies on a generic TODO; each task names exact files and commands.
- Type consistency: Hub internal route is `attendance`; legacy external keys remain `counter` and `delivery`; renderer layout remains `counter` for attendance receipts.
