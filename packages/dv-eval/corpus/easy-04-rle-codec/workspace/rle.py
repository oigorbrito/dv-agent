"""Codec RLE. Contrato em SPEC.md."""


def encode(text):
    raise NotImplementedError


def decode(payload):
    raise NotImplementedError


def compression_ratio(text):
    raise NotImplementedError
