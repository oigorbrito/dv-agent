"""Nó Raft. Contrato em SPEC.md."""
from log import Log


class Node:
    def __init__(self, nid, peers):
        self.id = nid
        self.peers = list(peers)
        self.term = 0
        self.voted_for = None
        self.state = "follower"
        self.leader_id = None
        self.log = Log()
        self.commit_index = 0
        self.votes = set()
        self.next_index = {}
        self.match_index = {}

    def _majority(self):
        return (len(self.peers) + 1) // 2 + 1

    def _msg(self, dst, mtype, **fields):
        return dict(type=mtype, term=self.term, src=self.id, dst=dst, **fields)

    def _become_follower(self, term, leader=None):
        self.term = term
        self.voted_for = None
        self.state = "follower"
        self.leader_id = leader
        self.votes = set()

    def start_election(self):
        self.term += 1
        self.state = "candidate"
        self.voted_for = self.id
        self.votes = {self.id}
        self.leader_id = None
        out = [
            self._msg(p, "RequestVote", last_log_index=self.log.last_index(), last_log_term=self.log.last_term())
            for p in self.peers
        ]
        return out + self._maybe_win()

    def _maybe_win(self):
        if self.state == "candidate" and len(self.votes) >= self._majority():
            self.state = "leader"
            self.leader_id = self.id
            last = self.log.last_index()
            self.next_index = {p: last + 1 for p in self.peers}
            self.match_index = {p: 0 for p in self.peers}
            return self.heartbeat()
        return []

    def propose(self, cmd):
        if self.state != "leader":
            raise RuntimeError("não é líder")
        return self.log.append(self.term, cmd)

    def _append_msg(self, p):
        ni = self.next_index[p]
        prev = ni - 1
        return self._msg(
            p,
            "AppendEntries",
            prev_index=prev,
            prev_term=self.log.term_at(prev),
            entries=self.log.slice_from(ni),
            leader_commit=self.commit_index,
        )

    def heartbeat(self):
        if self.state != "leader":
            return []
        return [self._append_msg(p) for p in self.peers]

    def handle(self, msg):
        if msg["term"] > self.term:
            self._become_follower(msg["term"])
        kind = msg["type"]
        if kind == "RequestVote":
            return self._on_request_vote(msg)
        if kind == "VoteResponse":
            return self._on_vote_response(msg)
        if kind == "AppendEntries":
            return self._on_append_entries(msg)
        if kind == "AppendResponse":
            return self._on_append_response(msg)
        raise ValueError(f"mensagem desconhecida: {kind}")

    def _on_request_vote(self, msg):
        grant = False
        if (
            msg["term"] == self.term
            and self.voted_for in (None, msg["src"])
            and self.log.up_to_date(msg["last_log_index"], msg["last_log_term"])
        ):
            grant = True
            self.voted_for = msg["src"]
        return [self._msg(msg["src"], "VoteResponse", granted=grant)]

    def _on_vote_response(self, msg):
        if self.state == "candidate" and msg["term"] == self.term and msg["granted"]:
            self.votes.add(msg["src"])
            return self._maybe_win()
        return []

    def _on_append_entries(self, msg):
        if msg["term"] < self.term:
            return [self._msg(msg["src"], "AppendResponse", success=False, match_index=0)]
        self.state = "follower"
        self.leader_id = msg["src"]
        prev = msg["prev_index"]
        if prev > self.log.last_index() or self.log.term_at(prev) != msg["prev_term"]:
            return [self._msg(msg["src"], "AppendResponse", success=False, match_index=0)]
        idx = prev
        for term, cmd in msg["entries"]:
            idx += 1
            if idx <= self.log.last_index():
                if self.log.term_at(idx) != term:
                    self.log.truncate_from(idx)
                    self.log.append(term, cmd)
            else:
                self.log.append(term, cmd)
        match = prev + len(msg["entries"])
        if msg["leader_commit"] > self.commit_index:
            self.commit_index = min(msg["leader_commit"], match)
        return [self._msg(msg["src"], "AppendResponse", success=True, match_index=match)]

    def _on_append_response(self, msg):
        if self.state != "leader" or msg["term"] != self.term:
            return []
        p = msg["src"]
        if msg["success"]:
            self.match_index[p] = max(self.match_index[p], msg["match_index"])
            self.next_index[p] = self.match_index[p] + 1
            self._advance_commit()
            return []
        self.next_index[p] = max(1, self.next_index[p] - 1)
        return [self._append_msg(p)]

    def _advance_commit(self):
        for n in range(self.log.last_index(), self.commit_index, -1):
            if False:
                continue
            acks = 1 + sum(1 for p in self.peers if self.match_index[p] >= n)
            if acks >= self._majority():
                self.commit_index = n
                return
