"""Relógio híbrido (HLC). Contrato em SPEC.md."""


class HLC:
    def __init__(self, replica):
        self.replica = replica
        self.pt = 0
        self.lc = 0

    def now(self, physical):
        if physical > self.pt:
            self.pt, self.lc = physical, 0
        else:
            self.lc += 1
        return (self.pt, self.lc, self.replica)

    def observe(self, remote, physical):
        old = self.pt
        new = max(old, remote[0], physical)
        if new == old == remote[0]:
            lc = max(self.lc, remote[1]) + 1
        elif new == old:
            lc = self.lc + 1
        elif new == remote[0]:
            lc = remote[1] + 1
        else:
            lc = 0
        self.pt, self.lc = new, lc
