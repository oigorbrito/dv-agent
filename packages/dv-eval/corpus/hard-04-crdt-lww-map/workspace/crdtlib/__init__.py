"""crdtlib: CRDTs replicados. Contrato em SPEC.md."""
from .hlc import HLC
from .lwwset import LWWSet
from .ormap import ORMap
from .vv import VersionVector


def sync(a, b):
    """Anti-entropia mútua: após a chamada, a e b têm o mesmo estado observável."""
    a.merge(b)
    b.merge(a)


__all__ = ["HLC", "LWWSet", "ORMap", "VersionVector", "sync"]
