from typing import Optional

from fastapi import HTTPException
from sqlalchemy.orm import Session

from database import SessionLocal, Setting
from security import clean_download_path


ALLOWED_SETTINGS = {
    "download_path",
    "max_concurrent",
    "connections_per_file",
    "auto_start_new_games",
    "browse_items_per_page",
    "browse_card_size",
    "browse_show_descriptions",
    "browse_open_links_new_tab",
    "library_card_size",
    "library_default_detail",
    "library_show_file_urls",
    "confirm_delete",
    "interface_scale",
    "theme_density",
    "reduce_motion",
}

INT_SETTING_RANGES = {
    "max_concurrent": (1, 32),
    "connections_per_file": (1, 16),
    "browse_items_per_page": (6, 60),
    "interface_scale": (85, 125),
}

CHOICE_SETTINGS = {
    "browse_card_size": {"compact", "medium", "large"},
    "library_card_size": {"compact", "medium", "large"},
    "theme_density": {"compact", "comfortable", "spacious"},
}

BOOL_SETTINGS = {
    "auto_start_new_games",
    "browse_show_descriptions",
    "browse_open_links_new_tab",
    "library_default_detail",
    "library_show_file_urls",
    "confirm_delete",
    "reduce_motion",
}

_settings_cache: dict[str, str] = {}


def load_settings_cache() -> dict[str, str]:
    global _settings_cache
    db = SessionLocal()
    try:
        _settings_cache = {row.key: row.value for row in db.query(Setting).all()}
        return dict(_settings_cache)
    finally:
        db.close()


def settings_snapshot(db: Optional[Session] = None) -> dict[str, str]:
    if _settings_cache:
        return dict(_settings_cache)
    if db is None:
        return load_settings_cache()
    return {row.key: row.value for row in db.query(Setting).all()}


def normalize_bool_setting(value) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    text = str(value).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return "true"
    if text in {"0", "false", "no", "off"}:
        return "false"
    raise ValueError("expected boolean")


def normalize_settings(data: dict) -> dict[str, str]:
    if not isinstance(data, dict):
        raise HTTPException(400, "Settings payload must be an object.")

    unknown = sorted(set(data) - ALLOWED_SETTINGS)
    if unknown:
        raise HTTPException(400, f"Unsupported setting(s): {', '.join(unknown)}")

    normalized: dict[str, str] = {}
    for key, value in data.items():
        if key in INT_SETTING_RANGES:
            try:
                number = int(value)
            except (TypeError, ValueError):
                raise HTTPException(400, f"{key} must be an integer.")
            low, high = INT_SETTING_RANGES[key]
            if not low <= number <= high:
                raise HTTPException(400, f"{key} must be between {low} and {high}.")
            normalized[key] = str(number)
            continue

        if key in BOOL_SETTINGS:
            try:
                normalized[key] = normalize_bool_setting(value)
            except ValueError:
                raise HTTPException(400, f"{key} must be a boolean.")
            continue

        if key in CHOICE_SETTINGS:
            text = str(value).strip()
            if text not in CHOICE_SETTINGS[key]:
                allowed = ", ".join(sorted(CHOICE_SETTINGS[key]))
                raise HTTPException(400, f"{key} must be one of: {allowed}.")
            normalized[key] = text
            continue

        text = str(value).strip()
        if key == "download_path":
            text = clean_download_path(text)
        normalized[key] = text

    return normalized


def persist_settings(db: Session, values: dict[str, str]) -> dict[str, str]:
    global _settings_cache
    for key, value in values.items():
        row = db.query(Setting).filter(Setting.key == key).first()
        if row:
            row.value = value
        else:
            db.add(Setting(key=key, value=value))
    db.commit()
    _settings_cache = {**settings_snapshot(db), **values}
    return dict(_settings_cache)
