"""Agenda de salas. Contrato em SPEC.md."""


class ScheduleError(ValueError):
    pass


def parse_instant(text):
    raise NotImplementedError


def make_interval(start, end):
    raise NotImplementedError


def overlap_kind(a, b):
    raise NotImplementedError


def merge_intervals(pairs, buffer_minutes=0):
    raise NotImplementedError


def can_book(existing, request, buffer_minutes):
    raise NotImplementedError


def schedule(existing, requests, buffer_minutes):
    raise NotImplementedError
