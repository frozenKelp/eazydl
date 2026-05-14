from typing import List, Optional

from pydantic import BaseModel, Field


class ListCreate(BaseModel):
    name: str


class LinksAdd(BaseModel):
    urls: List[str] = Field(default_factory=list, max_length=200)


class ScrapeRequest(BaseModel):
    game_url: str
    list_id: int


class GameAdd(BaseModel):
    title: str
    game_url: str
    image_url: Optional[str] = None
    description: Optional[str] = None
    size: Optional[str] = None
    categories: Optional[List[str]] = None


class DownloadBatch(BaseModel):
    ids: List[int] = Field(default_factory=list, max_length=500)
