"""Rate limiter multi-tenant. Contrato em SPEC.md."""


class RateLimiter:
    def __init__(self, clock):
        raise NotImplementedError

    def configure(self, route, limit, window_ms, sub_windows=4, burst=0):
        raise NotImplementedError

    def allow(self, tenant, route):
        raise NotImplementedError
