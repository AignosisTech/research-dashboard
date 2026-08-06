# 005 — Delete the dead clinic/billing subgraph

- **Status**: DONE (executed 2026-08-07)
- **Commit**: 1ed0f42 + uncommitted working-tree changes (see plans/README.md "Baseline")
- **Severity**: HIGH (maintainability)
- **Category**: Maintainability & architecture
- **Rule**: deslop/unused-file, deslop/unused-dependency
- **Estimated scope**: 37 files deleted, ~4,000 lines, plus dependency pruning

## Problem

This repo was forked from the clinic product. An entire feature cluster —
billing, doctor/test-admin management, the Mankind MR registration flow, the
notification centre, and the Firebase phone-auth wiring — came along and is
**unreachable from `src/main.tsx`**. `src/App.tsx:36-154` routes only: Login,
Dashboard, AllSessions, Camps, CampDetail, and the `/test/*` capture pages.

The canonical guidance for the rule is: _"Unused file is not reachable from any
entry point, so it adds maintenance surface without shipping any code."_ →
_"Delete the file if it is truly unreachable, or import it from an entry point."_

Why this is worth doing now rather than later:

- **It actively misleads greps and agents.** `src/lib/api/dashboard.ts` has five
  importers, so it looks alive — but every importer
  (`DoctorManagement.tsx`, `Header.tsx`, `useRazorpay.ts`,
  `AssessmentHistory.tsx`, `Profile.tsx`) is itself in the dead cluster. It is a
  closed unreachable subgraph that only whole-graph reachability reveals.
  `components/layout/Header.tsx` is especially deceptive: the live layout renders
  its own header from `DashboardLayout`.
- **It generates phantom audit findings.** Several scanner findings that read as
  real defects live only here — the `window-open-without-noopener` hits in
  `billing/InvoicesTable.tsx:57` and `billing/PaymentHistoryTable.tsx:42`, the
  `no-create-object-url-without-revoke` leak in `Profile.tsx:118`, the keyboard
  a11y gap in `NotificationCenter.tsx:105`, and five `no-giant-component` hits.
  Deleting the cluster retires them at zero risk; fixing them individually would
  be wasted work.
- **It ships weight and a wrong identity.** `src/lib/firebase/config.ts:5-13`
  hardcodes the **dev** Firebase project (`aignosis-dev1`) with no env
  indirection, and `src/lib/firebase/auth.ts` (phone OTP) has no importers —
  dead privileged code carrying a fixed dev-project binding.

## Target

Delete these 37 files. Verified at commit `1ed0f42`: none is reachable from
`src/main.tsx` by static import, dynamic `import()`, `import.meta.glob`,
`React.lazy`, `index.html`, or the PWA service-worker config.

    src/pages/dashboard/Billing.tsx
    src/pages/dashboard/OrderHistory.tsx
    src/pages/dashboard/Profile.tsx
    src/pages/dashboard/AssessmentHistory.tsx
    src/pages/auth/MankindRegistrationPage.tsx

    src/components/billing/ComplimentaryStatusCard.tsx
    src/components/billing/InvoiceStatusBadge.tsx
    src/components/billing/InvoicesTable.tsx
    src/components/billing/PaymentHistoryTable.tsx
    src/components/billing/PaymentStatusBadge.tsx
    src/components/common/ComingSoon.tsx
    src/components/common/StatusBadge.tsx
    src/components/dashboard/AssessmentHistoryFilters.tsx
    src/components/dashboard/AssessmentInlineErrorBanner.tsx
    src/components/dashboard/ComplimentaryBanner.tsx
    src/components/dashboard/DoctorManagement.tsx
    src/components/dashboard/FeatureBanner.tsx
    src/components/dashboard/TestAdminManagement.tsx
    src/components/layout/ComplimentaryTestsIndicator.tsx
    src/components/layout/Header.tsx
    src/components/layout/NotificationCenter.tsx

    src/hooks/useRazorpay.ts
    src/hooks/useTestStatusStream.ts
    src/hooks/useTestStatusStreamManager.ts

    src/lib/api/billing.ts
    src/lib/api/dashboard.ts
    src/lib/api/mankind.ts
    src/lib/api/testAdmin.ts
    src/lib/constants/mankindRegistration.ts
    src/lib/firebase/auth.ts
    src/lib/firebase/config.ts
    src/lib/utils/formatDate.ts
    src/lib/utils/phoneUtils.ts
    src/lib/validations/doctor.ts
    src/lib/validations/testAdmin.ts

    src/stores/dashboardStore.ts
    src/stores/notificationStore.ts

Then remove dependencies that only this cluster used. **Verify each with a fresh
`grep -rn "<pkg>" src/` returning nothing before removing it** — the graph may
have drifted:

    firebase              # only src/lib/firebase/*
    @hookform/resolvers   # zero imports anywhere at 1ed0f42
    next-themes           # zero imports anywhere at 1ed0f42

`react-hook-form` may also become unused once the cluster is gone — check, and
remove it only if nothing under `src/` imports it. Do **not** remove
`workbox-window`: it is a false positive, required by `virtual:pwa-register` in
`src/main.tsx:6`.

**Out of scope for this plan**: the 30 unused stock `src/components/ui/*` files.
They are library residue, and pruning them is a separate low-risk sweep with its
own Radix dependency implications (backlog item B4).

## Repo conventions to follow

- Deletions only. Do not refactor, rename, or "rescue" anything on the way out.
- If a live file imports a _symbol_ from a deleted module, that is a signal the
  reachability analysis was wrong — stop and report it rather than patching
  around it.

## Steps

1.  Re-verify reachability before deleting anything. From
    `core/research-dashboard/src`, for each file above confirm zero importers:

        grep -rEn "from '(@/|\.{1,2}/)[^']*/<basename>'" --include=*.ts --include=*.tsx .

    Also grep the repo for `import.meta.glob`, `React.lazy`, and any reference in
    `index.html` / `vite.config.ts` to be certain nothing loads them dynamically.
    **If any file in the list turns out to have a live importer, remove it from
    the deletion set and report that in the PR — do not delete it.**

2.  Delete the 37 files listed in Target.
3.  Delete now-empty directories (`src/components/billing/`, `src/lib/firebase/`,
    and `src/components/common/` if nothing remains).
4.  Run `npm run typecheck`. It must pass with zero errors. Any error here means a
    live file depended on the cluster — stop and report rather than deleting more.
5.  For each of `firebase`, `@hookform/resolvers`, `next-themes` (and
    `react-hook-form` if now unused), confirm `grep -rn "<pkg>" src/` is empty,
    then remove it from `package.json` dependencies and refresh the lockfile with
    the package manager the repo actually uses (see Boundaries).
6.  Run `npm run build` and confirm it succeeds.
7.  Re-read the diff: it must contain only deletions plus the `package.json` /
    lockfile change.

## Boundaries

- Do NOT delete anything under `src/components/ui/` in this plan.
- Do NOT delete `src/index.css`, `src/pages/test/webcam-test.css`, or
  `src/vite-env.d.ts` — the scanner correctly did not flag them; they are
  reached via CSS imports and TS config.
- Do NOT modify any file that survives, other than `package.json`.
- Do NOT remove `workbox-window`.
- **Lockfile caution**: this project currently contains **both**
  `package-lock.json` and `pnpm-lock.yaml`. Update only the lockfile matching the
  manager in actual use for this project and flag the duplicate in the PR — do
  not regenerate both, and do not switch managers as part of this plan.
- STOP if the code has drifted from the baseline described in plans/README.md and report the drift.

## Verification

- **Mechanical**:
  - `npm run typecheck` — clean.
  - `npm run lint` — clean.
  - `npm run build` — succeeds.
  - `npx react-doctor@latest` — the `unused-file` count drops by 37, the score
    **improves** from the 51 baseline, and no new diagnostic category appears.
- **Behavior check**: click through every live route and confirm nothing changed
  visually or functionally — `/login`, `/dashboard`, `/sessions`, `/camps`,
  `/camps/:campId` (import a roster, open the transfer dialog), and a full
  capture run `/test/fillup → webcam-test → calibration → video → questionnaire →
thankyou`. Watch the browser console for module-resolution errors on each
  route.
- **Bundle check**: compare `npm run build` output before and after; total chunk
  size must **decrease** (dropping the Firebase SDK alone is substantial). Record
  both numbers in the PR.
- **Done when**: typecheck/lint/build pass, all live routes behave identically,
  the `unused-file` count drops by 37 with an improved score, and the bundle is
  smaller.
