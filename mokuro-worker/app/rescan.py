"""Best-effort notification to library-server that new .mokuro data is on disk."""

import httpx

from .config import LIBRARY_SERVER_URL


async def trigger_library_rescan() -> None:
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(f"{LIBRARY_SERVER_URL}/api/rescan")
        response.raise_for_status()
