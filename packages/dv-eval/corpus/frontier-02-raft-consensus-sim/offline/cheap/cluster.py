"""Cluster simulado. Contrato em SPEC.md."""
from collections import deque

from node import Node


class Cluster:
    def __init__(self, ids):
        self.nodes = {i: Node(i, [j for j in ids if j != i]) for i in ids}
        self.queue = deque()
        self.cut = set()
        self.dropped = 0

    def cut_link(self, a, b):
        self.cut.add((a, b))

    def cut_both(self, a, b):
        self.cut.add((a, b))
        self.cut.add((b, a))

    def heal(self):
        self.cut.clear()

    def send(self, msgs):
        self.queue.extend(msgs)

    def elect(self, nid):
        self.send(self.nodes[nid].start_election())

    def replicate(self, nid):
        self.send(self.nodes[nid].heartbeat())

    def deliver(self, limit=100000):
        done = 0
        while self.queue:
            if done >= limit:
                raise RuntimeError("limite de entregas excedido")
            msg = self.queue.popleft()
            done += 1
            if (msg["src"], msg["dst"]) in self.cut:
                self.dropped += 1
                continue
            self.send(self.nodes[msg["dst"]].handle(msg))
        return done

    def leaders(self):
        return sorted(i for i, nd in self.nodes.items() if nd.state == "leader")
