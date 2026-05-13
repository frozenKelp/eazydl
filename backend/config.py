import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.abspath(os.path.join(BASE_DIR, ".."))
FRONTEND_DIR = os.path.join(PROJECT_ROOT, "frontend")

MAX_IMAGE_BYTES = 8 * 1024 * 1024
PROGRESS_DB_WRITE_INTERVAL = 5.0
START_RESOLVE_CONCURRENCY = 4

FITGIRL_HOSTS = {"fitgirl-repacks.site", "www.fitgirl-repacks.site"}
FUCKINGFAST_HOSTS = {"fuckingfast.co", "www.fuckingfast.co"}
