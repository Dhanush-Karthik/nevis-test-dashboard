# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- **Generate report (Run tests only).** Once a labelled run finishes, **Generate report** builds a print-ready document meant for a
  ticket or release mail: an editable title and optional free-text description, a cover with the run's environment/labels/exclusion
  labels and pass/fail summary, a per-scenario results table, and a detail section per scenario that opens with its whole sequence
  at a glance (every workflow/endpoint interaction it ran, in order, and where it stopped if it failed) before the existing
  per-step "main requests only" sequence diagrams (database calls, other external calls and trivially short calls are left out),
  and a failure-details section (with an optional raw pytest log excerpt). Every section is a checkbox, all on by default. A failed
  scenario can be marked **manually passed** for the report, with a reason shown in the document — this only changes what the
  report says; the run's real status, History and badges are untouched. The preview is the document itself, shown as one
  continuous sheet exactly as it prints — "Download PDF" hands that same markup to the browser's own print-to-PDF, so there's
  nothing to drift between what you see and what gets attached. Labelled **Beta**.
- **Light theme.** A sun/moon toggle at the top of the sidebar switches the whole dashboard between the existing dark theme and a
  new light one (remembered across reloads); dark stays the default and is pixel-identical to before.
- **Copy an action's log.** Each action under a workflow step in Scenario flow now has a copy icon that copies just its captured
  pytest lines to the clipboard.
- **Re-run a single scenario.** In Scenario flow, any scenario (passed or failed) has a **Re-run** button that re-executes only that
  one (pytest's own `-k`, matched against the scenario's name, so it works even for scenarios sharing labels with others in the run).
  Clicking it clears that scenario's steps and log right away and then visibly replaces it in place, live, as the re-run progresses.
  The result is persisted server-side against the run it replaces, so it's still there - the same way - after a page refresh, in
  **Run history**, and in **Generate report**; it's not a separate entry there, and only one run (the main one or a re-run) executes
  at a time. **Re-run also works from History now**, not just Run tests' own live view, against any run kept there.
- **Multiple scenarios in one file.** The Explorer's scenario switcher can now add (and remove a not-yet-saved) scenario to the
  currently open file, not just step between the ones already in it — so a new ticket file isn't limited to a single scenario.
- **Deployment controls & detail side panel.** Selecting a resource in the Deployments tree now opens a side panel (ArgoCD-style)
  instead of a card at the bottom of the page, showing its health, version and other metadata without scrolling, plus a **YAML** tab
  with its full manifest (`oc get ... -o yaml`) — not for Secrets, which stay metadata-only. The panel can **restart** a deployment
  (`oc rollout restart`) and **delete** a pod (its controller recreates it), each behind a confirm dialog naming the exact `oc`
  command and target before it runs, the same way the eID simulator control is confirmed. Everything else stays read-only. The tree
  now also keeps polling on its own, live, for as long as anything is mid-transition (a pod initializing after a restart or delete,
  for instance) - the same "settling" behavior ArgoCD shows - instead of a one-off snapshot that has to be manually refreshed.
- A blank **Workflow** starter (pick any flow) alongside the existing blank **Endpoint interaction** one.
- **Drag-select multiple blocks on the board**, then copy them (⌘/Ctrl+C, or the Properties panel's new **Copy** button) and paste
  (⌘/Ctrl+V) into any scenario — including one on a different tab. Delete now also removes a whole drag-selected group at once.
- **Output files tab.** Run tests, History (and a popped-out run window), and the Explorer's scenario test dock all get a new
  **Output** tab next to Scenario flow/Logs/Traces, listing whatever a run wrote under `output/` (downloaded PDFs, exported
  tokens/certs, screenshots, ...) with a size and a download link for each.

### Fixed
- A failed scenario's last action, in Scenario flow, no longer cuts off right at the PASSED/FAILED line — pytest's own failure
  report (captured log / traceback, often the actual failing request and response body) prints *after* that line and is now kept
  as part of the action instead of being dropped.
- A scenario re-run's result (passed or failed) no longer reverts back to the original, stale result after a page refresh.
- A pod initializing after a restart or delete no longer reads as unhealthy while it's still coming up - `Pending`,
  `ContainerCreating`, `PodInitializing`, `Init:N/M` and `Terminating` (and a `Running` pod whose containers aren't all ready yet) now
  correctly show as **progressing**, not degraded.
- **Report layout was badly broken.** The report has been rebuilt as a single continuous sheet instead of an on-screen A4-paged
  preview - the sequence diagrams could render wider than their own card and spill past its border, and the raw pytest log
  excerpt could silently truncate to its on-screen scroll height when printed instead of showing in full.
- **Namespace / pod-to-tail selections are now remembered and no longer re-fetched on their own** - in Run tests and in the
  Explorer's Test scenario dialog alike. Previously every reopen (and every namespace ticked) re-fetched the cluster's project
  and pod lists and made a dev recheck the same boxes; the fetched lists and the dev's own selection (any number of namespaces,
  not just the test's own one) are now both cached (per environment, pods per namespace), so opening either one is instant and a
  multi-namespace pick survives a rerun. Nothing is fetched again on its own unless there's no cache yet - a manual refresh, or a
  selected namespace/pod actually going missing (deleted, or a pod rescheduled under a new name), is what re-fetches from here on;
  a small warning appears in place the moment that's noticed, and hitting refresh both re-fetches and drops the now-gone selection
  so it doesn't sit there as a silent ghost. The Explorer's Test scenario dialog also now matches Run tests' own behavior: the OC
  project named like the scenario's test namespace is ticked automatically the first time nothing's been picked yet, and changing
  the "Run against namespace" dropdown mid-dialog drops the old namespace/pod pick and lands on the new one, instead of leaving
  pod tailing pointed at a namespace that's no longer being tested.
- **"Open in VS Code" failed on a long scenario's logs** (silently, past roughly 20k lines) — the server's request body limit
  (5mb) was too tight for a filtered log excerpt that size once JSON-escaped. Raised to 50mb.
- **Deployments no longer needs a manual refresh** to reflect a status change — it already polled continuously while something was
  visibly mid-transition; it now also polls on a slower baseline the rest of the time, so anything that changes on its own (a
  crash, someone else's deploy) still shows up without hitting refresh.
- The current run's status pill (Run tests / Scenario flow toolbar) no longer wraps onto a second line and spills out of its own
  rounded border when the toolbar gets tight — it stays on one line and ellipsizes instead.

## [1.3.0] - 2026-09-22

### Added
- **eID simulator control.** Run tests, and the Explorer's **Test scenario** dialog, now have a **Start/Stop** control and status for
  the AusweisApp2 podman container the suite uses for `eid`-labelled scenarios (the same container `lib/eid_helper.py` starts itself)
  — no separate terminal needed. If podman itself isn't running (the usual "connection refused" on macOS/Windows), **Start** boots
  the podman machine automatically first; nothing to run by hand.
- **Formatted JSON in pytest logs.** A JSON body embedded in a line of the pytest run's own output (not pod logs) is now
  pretty-printed in place, indented like the rest of the log — plain text, no extra box or button.
- Scenario **Labels** are now added as chips, like **Supported namespaces**, instead of a raw space-separated text field —
  suggestions come from labels already used elsewhere in the repo (excluding the auto-generated per-scenario uuid labels).
- The Explorer's **Test scenario** dialog now has its own **Exclusion labels** field (defaults to `eid`, same as Run tests) —
  previously fixed and not configurable there.

### Changed
- **Run tests** opens on **Scenario flow** by default (first tab, before Logs and Traces) instead of Logs.

### Fixed
- The sequence diagram's call detail panel can now be closed (✕) and expanded to a larger height, instead of being stuck open at
  a fixed size until another call was selected.
- When the trace list is hidden, its reopen button no longer overlaps the trace title.

## [1.2.1] - 2026-09-22

### Added
- **Search for pods to tail.** The "Pods to tail" list (Run tests, and the scenario test dock in the Explorer) now has its own filter
  box, next to the existing namespace filter, so a pod can be found by typing instead of scrolling.

## [1.2.0] - 2026-09-21

### Added
- **Canvas-style adding of blocks.** Click the board (or **+ Add block**, or the dashed **+** after the last block) and a menu slides in
  from the right and stays there (click the same control or empty board again to dismiss it; selecting a block replaces it with
  Properties): compact **Starters** (searchable) and the **Library**. A block picked after a board click lands where you clicked and joins the sequence
  after the last block automatically (no port dragging needed). An empty board offers **Add a block** and quick starters. The docked or
  floating Blocks panel is gone.
- **Editor tabs in the Explorer (like VS Code).** Every scenario you open gets a tab (scenario name + file), across files, each with
  its own kept draft, a dot for unsaved edits, a spinner while its test runs, middle-click or × to close, and the open tabs come back
  after a reload. Any tab can be tested on its own, but only one test runs at a time (the Test scenario button is disabled while one
  runs, and the server refuses a second run of any kind with a clear message).
- **Background run notifications.** A toast when a run starts or finishes while you are on another tab (click it to open that execution
  in History), and a pulsing badge on History with the number of runs in progress. **Git** shows a badge with the number of uncommitted
  changes, like VS Code.
- **Details prompt and hint.** Saving a scenario that still lacks a name (or a new one a namespace) now opens the Details popover with
  the missing fields highlighted instead of an error. When a file opens, a small pointer at the Details button appears for a few seconds
  (when there is something to fill in, and the first couple of times otherwise) and fades away on its own.
- **Drag to pan** the sequence diagram and the service graph with the mouse (hand tool); a drag never triggers a click.
- **Global search** (**Ctrl/⌘ K**, or the Search button at the top of the sidebar) across the whole dashboard: files, scenarios,
  labels, workflow and endpoint blocks, default configs, `.env` variable names (never values), History runs, traces (by id, step or
  scenario), span ids (seen in component logs, or in traces already opened; also by span name), Git (changed files, branches, commits), pages, and cluster resources the Deployments tab last loaded (deployments,
  pods, services, secret names and keys only). Results are grouped and colour-tagged by kind, chips narrow to one kind, arrow keys
  and Enter jump to the result (open the file or scenario, filter the library, select the run, open its traces, ...).
- **Sequence diagram** next to Graph and Timeline in a trace: components as lifelines (with version, host, span and error counts) and
  every request/response between them in the order it happened, numbered in pairs. Requests show method, route, host, query keys,
  content type, size and time in flight; responses show status text, duration, size, own work vs waiting and time back. Calls out to
  things that export no spans (databases, brokers, other services) appear as external participants, and slow or failed internal
  steps can be switched on. Colours mark success / redirect / failed, failures carry an error note, and a summary bar shows counts,
  end-to-end time and the slowest call. Click a message for a full panel: request and response, timing breakdown, span/trace ids,
  host and version, exception with stack, all attributes; and jump to the span in the timeline.
- **Pod logs while testing a scenario:** the Test scenario dialog can tail pods (cluster namespace, then pods) alongside pytest; the
  run panel gets a tab per source (pytest, each pod, all).
- **Library search by label:** each workflow/endpoint block knows the labels of the scenarios that use it, so the library search
  finds blocks by label (matching labels are shown on the row).
- **History tab.** Every run (Run tests and Test scenario) is listed with status, duration, namespace and passed/failed
  counts, grouped by day, with filters and search. Open one to see its scenario flow, logs and traces again, or pop it out.
  Runs stay in memory (last 30 finished) until the server restarts; single runs or all finished ones can be removed.
  Run tests reopens the last viewed run after a page refresh.
- **Explorer file management, VS Code style.** A Files toolbar (new file, new folder, refresh, collapse folders), right-click
  menus and keyboard shortcuts (F2 rename, Delete) with **Duplicate**, **Rename**, **Copy path** and **Delete** (confirmed),
  new empty test files and new folders, and drag & drop to move files. Duplicates get fresh uuid labels. Folders created outside
  the ones pytest reads are marked "not run". Changes are refused during a run.
- **Drafts are kept.** Unsaved edits per file survive opening another file, switching tabs and reloading the page; files with a
  draft show a dot. Save or Discard clears the draft.
- **More starters**, grouped as Workflows and Endpoints: register user (EGK, fake-auth), login (EGK), step-up login (eID),
  register device (OTP / forgot PIN), and the frequent endpoints change-email, introspect, revoke, backend-token and ident-cases.
- **Trace graph shows every call, not just a count.** Each connection between components now carries a summary pill
  (calls · total time · failures). Click a connection to open a **Calls** panel listing each call in time order: offset,
  method and route, status code, and a duration bar placed on the trace's time axis; expand a call for the request URL,
  the sending and handling spans, host, error message or DB statement, and jump to that span in the timeline.
  A **Calls on graph** toggle lists the first calls right on the connections. The connection with failures is
  selected automatically, and failed calls are marked red. Works with old and new OpenTelemetry HTTP attribute names.

### Changed
- **Open in VS Code:** the log toolbar's editor drop-down is now a single **Open in VS Code** button that opens the (filtered) logs there.
- **Trace titles:** traces are named after their workflow / endpoint interaction (the root request, the same for every workflow of a
  scenario, is now the second line, with the start offset), and the trace header shows the step, scenario and root request.
- **Fewer confusing extra traces:** the suite starts one trace per workflow or endpoint call (that is by design). Other traces harvested
  from component logs during a step (the suite's `/reset` calls, background jobs, other people's traffic) no longer sit next to it:
  only traces whose inbound request carried the suite's `traceparent` are listed, and the rest are behind "Show N other traces from logs".
- **Explorer layout, more like VS Code:** *Files* runs the full height of the window. The scenario's identity is a small chip on the board
  (name, namespaces, a dot when something required is missing) that opens the **Scenario details** in the same floating side panel as
  block **Properties** (name, description, labels, namespaces, and a **Clear output folder** toggle); that panel is only there while it is in use, and Save opens it
  with the missing fields highlighted. Nothing sits in the toolbar or takes layout space when idle. The Files toolbar icons are evenly spaced.
- **Run tests matches the Explorer:** the **Run tests** button (Stop while running) is now the primary button at the right of the
  top toolbar, where Test scenario / Save sit in the Explorer, instead of at the bottom of the configuration panel.
- The **Create new test** tab is merged into the **Explorer**: creating a test is now "new file, then add blocks and scenarios". **Files** is a panel of its own, and the **Starters** and **Library** live in the add menu on the board.
  The old ticket-named "Create file" / "Add to existing file" dialog goes away: scenarios are saved into the file you are editing.
- `start.sh` now detects what a `git pull` changed: it reinstalls dependencies when a lockfile changed, rebuilds the client
  when its sources changed, and restarts a dashboard that is still running old code. No manual `npm install` / `npm run build`.

### Fixed
- The board pans with the wheel / trackpad in both directions, limited so the blocks never scroll out of view.
- The board shifted to the right when no scenario was open after the blocks panel had been used.
- The History run list can be hidden and shown again (and resized) like the other side panels.
- A long root request in the trace list no longer overflows: it is cut with an ellipsis (full text on hover).
- Logs in the Explorer's test-run panel were pushed to the right when the pod-log tab strip was shown (the tabs and the log panel shared
  one row); they stack again.

## [1.1.0] - 2026-09-21

### Added
- **OpenShift re-login from the dashboard.** When the 24-hour `oc` login expires, a dialog takes the cluster address and the
  one-time passcode and runs `oc login` on your behalf, then reloads the data that failed to load. A sidebar chip shows the
  login state. The passcode is never stored or logged; the cluster address is remembered in the browser only.
- **Push from the Git tab**, with a confirmation. A branch without an upstream is pushed with `--set-upstream`; the dashboard never forces.
- **Separate windows.** Any view, and a run's logs, scenario flow and traces, can be opened in its own window (sidebar pop-out
  icon, **Pop out** menu in Run tests, pop-out buttons on the log toolbar and the Explorer/Create test run panel, and the
  shortcuts Ctrl+Alt+O / Ctrl+Alt+L, ⌘⌥O / ⌘⌥L on a Mac).
- **Settings tab** (global) with two editors, **Default configs** and **.env**, switched with a toggle at the top; both keep unsaved edits while you switch. Default configs edits `config/defaults/*.yaml` (namespaces, workflows, endpoint interactions): add a config from a
  dropdown of known configs, edit, delete, add or delete a whole namespace (optionally copied from another), with a diff
  preview before anything is written.
  The **.env** editor edits the project's `.env` (masked values, suggestions for variables the project reads, raw text mode,
  warning when the file is not git-ignored, key-only save summary).
- Nevis favicon on the browser tab.
- Scenario-level options: a compact **Clear output** dropdown (the app's own select) (Default / Yes / No → `clear_output`) in the header of the
  scenario details section of Explorer and Create test. Written only when set; other scenario keys stay untouched.
- Traces for failed flows: trace ids are now also harvested from the components' own log lines (pod tails,
  `<time> <traceId> <spanId>` and printed `traceparent` headers) and attached to the step running at that time,
  so no changes to the pytest suite are needed. Traces with ERROR lines are listed first and mark the step's
  "View trace". Works even when the suite logs no trace ids.

### Changed
- Scenario flow: the running step (else the last, i.e. the failed one) is selected automatically and follows the run until you pick a card yourself, so its action details are open by default. Only the live action is expanded; when a step finishes all its actions collapse, and a failed step keeps the failed action open. The live action's log follows the newest lines (scroll up to stop following), and the latest scenario is selected automatically until you pick one.
- **Git commits use the index.** Nothing is selected by default: stage the files you want (per file or all), then commit
  what is staged. Unstaged and staged changes are listed separately, each with its own diff.
- `start.sh` prints the last lines of the server log when the server fails to start.

### Fixed
- The trace list could stay empty when a run finished between two refreshes; it is now reloaded when the run ends.

## [1.0.0]

Initial release: Explorer, Run tests with live logs, Create new test, Tracing, Deployments and Git.
