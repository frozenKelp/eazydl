# EasyDL

EasyDL is a local web download manager for FitGirl/FuckingFast workflows. It lets
you browse supported pages, save entries to a personal library, and control
downloads through `aria2c` from a simple browser UI.

Use it only for content you are legally allowed to download.

## Contents

- [What It Does](#what-it-does)
- [Features](#features)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Usage](#usage)
- [Configuration](#configuration)
- [Project Layout](#project-layout)
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

The backend stores data in SQLite and sends downloads to `aria2c` through
`aria2p`. The frontend is plain HTML, CSS, and JavaScript.

## Features

- Local-first browser UI.
- Browse and search supported source pages.
- Save title, cover image, size, description, and categories.
- Extract supported download links into your library.
- Start, pause, resume, stop, and delete downloads.
- View live progress, speed, status, and file size.
- Configure concurrent downloads and connections per file.
- Resume partial files when the source and `aria2c` support it.
- Run with either `uv` or a standard Python virtual environment.

## Requirements

- Python 3.10 or newer.
- `aria2c` installed and available on `PATH`.
- Python packages from `requirements.txt`.

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

### With uv

```bash
uv venv
uv pip install -r requirements.txt
uv run python run.py
```

### With pip

Create a virtual environment:

```bash
python -m venv .venv
```

Activate it:

```powershell
.\.venv\Scripts\Activate.ps1
```

On macOS or Linux:

```bash
source .venv/bin/activate
```

Install dependencies and run:

```bash
python -m pip install -r requirements.txt
python run.py
```

Open:

```text
http://localhost:8000
```

## Usage

1. Open Browse.
2. Search for an entry or load the popular list.
3. Click Add to save it to your Library.
4. Open Library.
5. Start a game or individual files.
6. Use Pause, Resume, Stop, and Delete as needed.
7. Open Settings to change paths, concurrency, and UI preferences.

Downloads go to the configured download path. By default, that is the repo-local
`downloads/` folder.

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

Run the dev server:

```bash
uv run python run.py
```

By default the server binds to `127.0.0.1` without hot reload. For development,
enable reload explicitly:

```powershell
$env:EASYDL_RELOAD="true"
python run.py
```

You can also override `EASYDL_HOST` and `EASYDL_PORT` when needed.

Frontend files are served directly from `frontend/`, so refresh the browser after
editing HTML, CSS, or JavaScript.

Run a syntax check:

```bash
uv run python -m py_compile backend/database.py backend/scraper.py
uv run python -m py_compile backend/main.py backend/downloader.py run.py
```

Without `uv`, run the same commands with `python` from your active virtual
environment.

## Contributing

Contributions are welcome when they keep the app local-first, readable, and safe
to run.

Before larger changes, open an issue or describe the plan. Keep pull requests
focused, avoid generated files, and preserve support for both `uv` and standard
Python installs.

Suggested workflow:

1. Fork or branch from the main development branch.
2. Install dependencies with `uv pip install -r requirements.txt`.
3. Make your change.
4. Run the syntax check above.
5. Test the relevant UI flow in the browser.
6. Submit a pull request with a short summary and test notes.

Good first contributions:

- Improve empty, loading, or error states.
- Add focused tests around scraper helpers.
- Harden URL validation before network requests.
- Improve duplicate-link handling.
- Add screenshots or a short demo GIF.
- Document platform-specific `aria2c` setup steps.

Code style:

- Prefer small, readable changes.
- Keep backend blocking I/O out of the async event loop.
- Follow the existing vanilla JavaScript patterns.
- Keep Markdown lint-friendly.
- Add new frameworks only when the benefit is clear.

## Troubleshooting

### `aria2c` Shows Offline

Check that `aria2c` is installed:

```bash
aria2c --version
```

If port `6800` is already in use, stop the other process or change the RPC port
in the downloader code.

### Browse Has No Results

Browse depends on remote pages and their HTML structure. Try another query,
reduce the page size, or check whether the site is reachable from your machine.

### Downloads Stay Pending

Common causes:

- `aria2c` is offline.
- The source page structure changed.
- The resolved download URL expired.
- The configured download path is not writable.

## Security and Legal Notes

EasyDL is a local personal tool. Do not expose it to the public internet without
authentication, stricter URL validation, and careful review of filesystem write
paths.

This project does not grant permission to download copyrighted material. You are
responsible for source-site terms and applicable law.

## License

``` text
MIT License

Copyright (c) [2026] [frozenKelp]

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
