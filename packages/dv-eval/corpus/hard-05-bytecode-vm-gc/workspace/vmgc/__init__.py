"""vmgc: compilador, VM de pilha e GC mark-and-sweep. Contrato em SPEC.md."""
from .compiler import CompileError, compile_source
from .gc import ArrayObj, Closure, DanglingReference, Heap, Ref
from .vm import VM, VMError


def run_source(source, threshold=8):
    program = compile_source(source)
    vm = VM(program, threshold=threshold)
    result = vm.run()
    return {
        "value": vm.to_python(result),
        "collections": vm.heap.collections,
        "live": len(vm.heap.objects),
        "allocated": vm.heap.allocations,
        "output": list(vm.output),
    }


__all__ = [
    "ArrayObj",
    "Closure",
    "CompileError",
    "DanglingReference",
    "Heap",
    "Ref",
    "VM",
    "VMError",
    "compile_source",
    "run_source",
]
