# EasyDL

EasyDL is a local web download manager for FitGirl/FuckingFast workflows.
It lets you browse supported pages, add entries to a personal library, and
control downloads through `aria2c` from a simple browser UI.

Use this project only for content you are legally allowed to download.

## Contents

- [What It Does](#what-it-does)
- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Development](#development)
- [Contributing](#contributing)
- [Troubleshooting](#troubleshooting)
- [Security and Legal Notes](#security-and-legal-notes)
- [License](#license)

## What It Does

EasyDL runs a FastAPI server on your machine and serves three pages:

- Library: saved games, file progress, and download controls.
- Browse: search or browse supported source pages and add items.
- Settings: download path, concurrency, appearance, and runtime status.

The backend stores data in SQLite and delegates downloads to `aria2c` through
the `aria2p` Python library. The frontend is plain HTML, CSS, and JavaScript.

## Features

- Local-first web UI with no hosted service.
- Browse and search supported source pages.
- Save entries with title, cover image, size, description, and categories.
- Extract supported download links into a local library.
- Start, pause, resume, stop, and delete downloads.
- Show live progress, speed, status, and file size.
- Configure concurrent downloads and connections per file.
- Resume partial files when the source and `aria2c` support it.
- Works with either `uv` or standard Python virtual environments.

## Requirements

- Python 3.10 or newer.
- `aria2c` installed and available on `PATH`.
- Dependencies from `requirements.txt`.

Install `aria2c`:

| Platform | Command |
| --- | --- |
| Ubuntu or Debian | `sudo apt install aria2` |
| macOS | `brew install aria2` |
| Windows | Install [aria2](https://aria2.github.io/) and update `PATH` |

## Quick Start

Clone the repository:

```bash
git clone <repo-url>
cd eazydl
```

### Option 1: uv

Create an environment and install dependencies:

```bash
uv venv
uv pip install -r requirements.txt
```

Run the app:

```bash
uv run python run.py
```

### Option 2: pip

Create and activate a virtual environment:

```bash
python -m venv .venv
```

On Windows:

```powershell
.\.venv\Scripts\Activate.ps1
```

On macOS or Linux:

```bash
source .venv/bin/activate
```

Install dependencies and run the app:

```bash
python -m pip install -r requirements.txt
python run.py
```

Open the app:

```text
http://localhost:8000
```

## Usage

1. Open the Browse page.
2. Search for an entry or load the popular list.
3. Click Add to save it to your Library.
4. Open the Library page.
5. Click Start on a game or on individual files.
6. Use Pause, Resume, Stop, and Delete as needed.
7. Open Settings to change paths, concurrency, and UI preferences.

Downloaded files are saved under the configured download path. By default,
that path is the repository-local `downloads/` directory.

## Configuration

Settings are stored in SQLite and can be changed from the Settings page.

| Setting | Purpose |
| --- | --- |
| `download_path` | Base folder for downloaded files. |
| `max_concurrent` | Maximum active downloads in aria2. |
| `connections_per_file` | Number of aria2 splits per file. |
| `auto_start_new_games` | Start links after adding from Browse. |
| `browse_items_per_page` | Number of cards on Browse pages. |
| `browse_card_size` | Browse card size. |
| `library_card_size` | Library card size. |
| `confirm_delete` | Ask before deleting games or links. |
| `interface_scale` | UI scale percentage. |
| `theme_density` | Compact, comfortable, or spacious layout. |
| `reduce_motion` | Disable non-essential UI motion. |

## Project Layout

```text
eazydl/
|-- backend/
|   |-- main.py
|   |-- downloader.py
|   |-- scraper.py
|   `-- database.py
|-- frontend/
|   |-- library.html
|   |-- browse.html
|   |-- settings.html
|   |-- css/
|   `-- js/
|-- data/
|-- downloads/
|-- requirements.txt
`-- run.py
```

## Development

Run the development server:

```bash
uv run python run.py
```

The server uses reload mode for files in `backend/`. Frontend files are served
directly from `frontend/`, so refresh the browser after changing HTML, CSS, or
JavaScript.

Run a syntax check:

```bash
uv run python -m py_compile backend/database.py backend/scraper.py
uv run python -m py_compile backend/main.py backend/downloader.py run.py
```

If you are not using `uv`, run the same commands with `python` from your active
virtual environment.

## Contributing

Contributions are welcome when they keep the app local-first, understandable,
and safe to run.

### Before You Start

1. Open an issue or describe the change before large rewrites.
2. Keep changes focused on one feature or fix.
3. Avoid committing generated files, local databases, or downloads.
4. Preserve compatibility with both `uv` and standard Python installs.

### Suggested Workflow

1. Fork or branch from the main development branch.
2. Install dependencies with `uv pip install -r requirements.txt`.
3. Make your change.
4. Run the syntax check above.
5. Test the relevant UI flow in the browser.
6. Submit a pull request with a short summary and test notes.

### Good First Contributions

- Improve empty, loading, or error states in the UI.
- Add focused tests around scraper helpers.
- Harden URL validation before network requests.
- Improve duplicate-link handling.
- Add screenshots or a short demo GIF to the README.
- Document platform-specific `aria2c` setup steps.

### Code Style

- Prefer small, readable changes.
- Keep backend blocking I/O out of the async event loop.
- Use existing vanilla JavaScript patterns on the frontend.
- Keep Markdown lint-friendly when editing docs.
- Do not add new frameworks unless the benefit is clear.

## Troubleshooting

### `aria2c` Shows Offline

Check that `aria2c` is installed:

```bash
aria2c --version
```

If port `6800` is already in use, stop the other process or change the RPC port
in the downloader code.

### Browse Has No Results

Browse depends on remote page availability and HTML structure. Try a different
query, reduce the page size, or check whether the site is reachable from your
machine.

### Downloads Stay Pending

Common causes:

- `aria2c` is offline.
- The source page structure changed.
- The resolved download URL expired.
- The configured download path is not writable.

## Security and Legal Notes

EasyDL is designed as a local personal tool. Do not expose it directly to the
public internet without authentication, stricter URL validation, and careful
review of filesystem write paths.

This project does not grant permission to download copyrighted material. You
are responsible for complying with source-site terms and applicable law.

## License

No license file is currently included. Add a license before distributing the
project publicly or accepting external contributions.
