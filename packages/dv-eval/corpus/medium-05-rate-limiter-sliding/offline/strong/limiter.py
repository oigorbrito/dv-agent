"""Rate limiter multi-tenant. Contrato em SPEC.md."""
import math
from collections import deque
from fractions import Fraction


class RateLimiter:
    def __init__(self, clock):
        self._clock = clock
        self._routes = {}
        self._state = {}

    def configure(self, route, limit, window_ms, sub_windows=4, burst=0):
        if limit < 1 or window_ms < 1 or sub_windows < 1 or burst < 0:
            raise ValueError("parâmetros inválidos")
        if window_ms % sub_windows:
            raise ValueError("window_ms deve ser múltiplo de sub_windows")
        self._routes[route] = {
            "limit": limit,
            "window": window_ms,
            "width": window_ms // sub_windows,
            "burst": burst,
        }

    def allow(self, tenant, route):
        cfg = self._routes.get(route)
        if cfg is None:
            raise ValueError(f"rota desconhecida: {route}")
        now = self._clock()
        st = self._state.setdefault(
            (tenant, route),
            {"buckets": deque(), "tokens": Fraction(cfg["burst"]), "last": now},
        )
        if cfg["burst"]:
            elapsed = now - st["last"]
            st["tokens"] = min(
                Fraction(cfg["burst"]),
                st["tokens"] + Fraction(elapsed * cfg["limit"], cfg["window"]),
            )
        st["last"] = now
        buckets = st["buckets"]
        while buckets and buckets[0][0] + cfg["window"] <= now:
            buckets.popleft()
        count = sum(c for _, c in buckets)
        blocked_window = count >= cfg["limit"]
        window_wait = 0
        if blocked_window:
            need = count - cfg["limit"] + 1
            freed = 0
            for start, c in buckets:
                freed += c
                if freed >= need:
                    window_wait = start + cfg["window"] - now
                    break
        blocked_bucket = bool(cfg["burst"]) and st["tokens"] < 1
        bucket_wait = 0
        if blocked_bucket:
            missing = 1 - st["tokens"]
            bucket_wait = math.ceil(missing * cfg["window"] / cfg["limit"])
        if blocked_window or blocked_bucket:
            return False, max(window_wait, bucket_wait)
        if cfg["burst"]:
            st["tokens"] -= 1
        start = now - now % cfg["width"]
        if buckets and buckets[-1][0] == start:
            buckets[-1] = (start, buckets[-1][1] + 1)
        else:
            buckets.append((start, 1))
        return True, 0
