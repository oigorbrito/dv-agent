"""Cache LRU com TTL. Contrato em SPEC.md."""


class TTLCache:
    def __init__(self, capacity, default_ttl=None, clock=None):
        raise NotImplementedError
