"""Log replicado. Contrato em SPEC.md."""


class Log:
    def __init__(self):
        self.entries = []

    def last_index(self):
        return len(self.entries)

    def last_term(self):
        return self.entries[-1][0] if self.entries else 0

    def term_at(self, i):
        if i == 0:
            return 0
        if i < 0 or i > len(self.entries):
            return None
        return self.entries[i - 1][0]

    def append(self, term, cmd):
        self.entries.append((term, cmd))
        return len(self.entries)

    def truncate_from(self, i):
        del self.entries[i - 1:]

    def slice_from(self, i):
        return list(self.entries[i - 1:])

    def up_to_date(self, last_index, last_term):
        if last_term != self.last_term():
            return last_term > self.last_term()
        return last_index >= self.last_index()
