# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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
