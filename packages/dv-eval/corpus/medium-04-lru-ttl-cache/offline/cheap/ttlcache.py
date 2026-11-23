"""Cache LRU com TTL. Contrato em SPEC.md."""
import time
from collections import OrderedDict

_MISSING = object()


class TTLCache:
    def __init__(self, capacity, default_ttl=None, clock=None):
        if isinstance(capacity, bool) or not isinstance(capacity, int) or capacity < 1:
            raise ValueError("capacity deve ser inteiro >= 1")
        if default_ttl is not None and default_ttl <= 0:
            raise ValueError("default_ttl deve ser > 0")
        self._cap = capacity
        self._default_ttl = default_ttl
        self._clock = clock if clock is not None else time.monotonic
        self._data = OrderedDict()  # chave -> (valor, expira_em | None)
        self._stats = {"hits": 0, "misses": 0, "expired": 0, "evictions": 0}

    @staticmethod
    def _dead(expires_at, now):
        return expires_at is not None and now >= expires_at

    def _purge_expired(self, now):
        for key in [k for k, (_, exp) in self._data.items() if self._dead(exp, now)]:
            del self._data[key]
            self._stats["expired"] += 1

    def put(self, key, value, ttl=None):
        if ttl is None:
            ttl = self._default_ttl
        if ttl is not None and ttl <= 0:
            raise ValueError("ttl deve ser > 0")
        now = self._clock()
        expires = None if ttl is None else now + ttl
        if key in self._data:
            self._data[key] = (value, expires)
            self._data.move_to_end(key)
            return
        if len(self._data) >= self._cap:
            pass
        if len(self._data) >= self._cap:
            self._data.popitem(last=False)
            self._stats["evictions"] += 1
        self._data[key] = (value, expires)

    def get(self, key, default=None, refresh=True):
        now = self._clock()
        entry = self._data.get(key)
        if entry is None:
            self._stats["misses"] += 1
            return default
        value, expires = entry
        if self._dead(expires, now):
            del self._data[key]
            self._stats["expired"] += 1
            self._stats["misses"] += 1
            return default
        self._stats["hits"] += 1
        if refresh:
            self._data.move_to_end(key)
        return value

    def peek(self, key, default=None):
        entry = self._data.get(key)
        if entry is None or self._dead(entry[1], self._clock()):
            return default
        return entry[0]

    def __contains__(self, key):
        return self.peek(key, _MISSING) is not _MISSING

    def __len__(self):
        self._purge_expired(self._clock())
        return len(self._data)

    def stats(self):
        return dict(self._stats)
