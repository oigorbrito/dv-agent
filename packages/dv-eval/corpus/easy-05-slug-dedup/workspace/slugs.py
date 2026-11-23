"""Slugs ASCII determinísticos. Contrato em SPEC.md."""


def make_slug(title, max_len=40):
    raise NotImplementedError


class Slugger:
    def __init__(self, reserved=(), max_len=40):
        raise NotImplementedError

    def assign(self, title):
        raise NotImplementedError
