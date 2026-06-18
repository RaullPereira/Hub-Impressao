# Hub Impressao 1.8 Release Design

## Context

Hub Impressao is the local print executor for Pedidos Hub. The 1.8 release must reduce the risk of prints crossing sectors, keep automatic printing fast and reliable, avoid duplicate tickets, and clean up the local UI.

The release must validate both repositories:

- Hub Impressao: `/Users/raulpereiradecastro/thermal-print-service`
- Pedidos Hub: `/Users/raulpereiradecastro/Sistemadegerenciamentodepedidos`

The rollout must not force existing customers to reconfigure printers. Compatibility with legacy setups is a product requirement.

## Goals

- Prevent kitchen printers from printing customer/attendance receipts.
- Prevent attendance printers from printing kitchen tickets.
- Treat balcony, dining room, and delivery as one customer-facing attendance route.
- Preserve legacy customers with minimal operational disruption.
- Keep manual prints and reports available through the default printer behavior.
- Ensure auto-print on arrival, auto-print on accept, browser fallback, and manual click print do not duplicate each other.
- Ship a consistent `1.8.0` release across package metadata, WebSocket handshake, installer metadata, and local UI.
- Simplify the Hub Impressao interface so operators can see status, pairing, printer roles, and recent print events quickly.

## Non-Goals

- Do not make every existing customer review printer settings before upgrading.
- Do not introduce a separate delivery print sector. Delivery is an alias of the attendance route.
- Do not remove manual reprint behavior. Manual click print remains explicit and can reprint the same order.
- Do not redesign Pedidos Hub broadly outside the print integration contract.

## Print Routes

The release uses two automatic routes:

1. `kitchen`
   - Kitchen/preparation ticket.
   - Must not print the complete customer receipt.

2. `attendance`
   - Complete customer-facing receipt.
   - Covers balcony, dining room, pickup, and delivery.
   - Existing `counter`, `balcao`, `salao`, and `delivery` concepts map to this route for automatic routing.

`default` is not a separate automatic route. A default printer can auto-print only inside its configured route. It is also the preferred destination for manual/general documents such as tests, manual text, cash reports, closing reports, and explicit reprints.

## Compatibility Model

Hub Impressao and Pedidos Hub keep two modes.

### Legacy Mode

Legacy mode applies when no explicit per-printer automatic route configuration exists.

- Existing global `autoPrintType` behavior remains available.
- Existing customers keep printing after upgrade.
- Fallback behavior is preserved to avoid client-side reconfiguration.
- The UI can warn about ambiguous configuration, but must not block operation.

### Routed Mode

Routed mode applies when there is explicit per-printer automatic routing.

- Kitchen auto-prints only to kitchen.
- Attendance auto-prints only to attendance.
- Delivery is normalized to attendance.
- Default printers participate only through their own configured route.
- No printer may receive the other route only because it is marked default.
- Missing route configuration is handled with a non-blocking warning and logs, not forced migration.

## Pedidos Hub Contract

Pedidos Hub remains the source of configuration and official render payloads.

It must:

- Build and sync local printer settings to Hub Impressao.
- Normalize `delivery` to the attendance route for automatic routing.
- Preserve `default` for manual/general documents and legacy compatibility.
- Use Hub Impressao as the authoritative auto-print executor when the local service is paired, active, and owns auto-print.
- Mount browser auto-print hooks only when Hub Impressao is not controlling auto-print.
- Use `/api/print/render` for official payloads when the local order payload is incomplete.
- Keep local fast render when the order already has enough inline printable data.

## Hub Impressao Contract

Hub Impressao must:

- Store route-aware printer settings per paired store.
- Accept legacy settings without breaking them.
- Normalize `counter`, `balcao`, `salao`, and `delivery` to attendance for automatic routing.
- Keep `kitchen` distinct.
- Reject cross-route automatic fallback in routed mode.
- Allow manual/default printing for reports, tests, manual text, and explicit reprints.
- Track auto-print ownership and avoid browser/service double execution.
- Expose clear status to the UI and logs.

## Duplicate Prevention

The system must enforce one owner per automatic print event.

- If Hub Impressao is paired and active, it owns auto-print.
- Pedidos Hub browser listeners do not auto-print while Hub Impressao owns auto-print.
- If Hub Impressao is unavailable, Pedidos Hub browser fallback may auto-print.
- Manual click print bypasses automatic duplicate guards because it is an explicit operator action.
- Auto-print uses a ledger by route, not by order only:
  - `kitchen`
  - `attendance`
- If a physical print fails after a claim, the claim is released or marked retriable so recovery can try again.
- If both routes target distinct physical printers, they may print in parallel.
- If both routes target the same physical printer, they print sequentially with a short buffer-safe delay.

## Accept-Only Printing

For digital-menu orders configured to print only when accepted:

- Arrival does not print while the order is awaiting acceptance.
- Accepted orders print once through the current auto-print owner.
- Rejected or canceled orders do not print.
- Recovery/watchdog paths must catch accepted orders if a realtime event is missed.
- Manual print remains available at any time.

## UI Design

Hub Impressao should become a clean operational panel aligned with Pedidos Hub.

Primary screen:

- Service status.
- Paired store.
- Auto-print ownership state.
- Number of detected printers.
- Recent print activity.

Printer screen:

- Detected printer list.
- Route/role display:
  - Kitchen
  - Attendance
  - Default inside its route
  - Manual/general documents
- Test print.
- Manual text print.

Warnings:

- No kitchen printer configured.
- Default printer is being used for attendance.
- Delivery uses attendance.
- Hub local controls auto-print.
- Browser fallback is active because Hub local is unavailable.

Visual direction:

- White, restrained, operational UI.
- Lime/green accent aligned with Pedidos Hub.
- Fewer decorative cards.
- Logs should be easier to scan and tied to print events.

## Versioning

The release version is `1.8.0`.

The version must be consistent in:

- `package.json`
- `package-lock.json`
- WebSocket connected payload
- renderer UI footer/status
- installer metadata where applicable
- generated build artifacts only if build process updates them intentionally

## Testing Plan

Hub Impressao tests should cover:

- Kitchen does not print attendance receipt in routed mode.
- Attendance does not print kitchen ticket in routed mode.
- Default printer auto-prints only inside its configured route.
- Delivery aliases to attendance.
- Legacy mode still prints without new configuration.
- Accept-only prints once after acceptance.
- Manual print can reprint despite auto-print guards.
- Same-printer two-route printing is sequential.
- Distinct-printer two-route printing is parallel or non-blocking.
- Failed physical print releases/retries the claim.
- HTTP, WebSocket, and Supabase listener paths use the same route rules.

Pedidos Hub tests should cover:

- Configuration sync sends attendance/kitchen routes correctly.
- Delivery is normalized to attendance.
- Browser auto-print hooks are disabled while Hub Impressao owns auto-print.
- Browser fallback uses route-aware dispatch when Hub Impressao does not own auto-print.
- `/api/print/render` still returns valid `rawContent` for kitchen and attendance layouts.
- Manual click print bypasses duplicate guard.

## Verification Plan

Minimum verification before implementation is considered complete:

1. Run focused Hub Impressao tests.
2. Run focused Pedidos Hub print tests.
3. Run Hub Impressao build or package validation.
4. Run Pedidos Hub typecheck or focused build-level validation when Pedidos Hub files change.
5. Inspect final git diff for unintended unrelated changes.

Current observed baseline during design:

- Hub Impressao focused tests passed except HTTP local-listen test required unsandboxed localhost permission in the previous sandbox mode.
- Pedidos Hub focused print tests passed: 6 files, 50 tests.

## Implementation Notes

- Use a shared normalizer for print routes where possible.
- Keep legacy naming compatibility at boundaries, but use `attendance` internally for clarity.
- Avoid a hard migration prompt for clients.
- Prefer additive warnings and clear logs over blocking changes.
- Keep edits scoped to print routing, duplicate prevention, UI clarity, and version consistency.
