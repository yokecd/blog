---
author: David Desmarais-Michaud
pubDatetime: 2025-03-23T01:25:07.421Z
workInProgress: true
title: Interfacing with WebAssembly in Go
slug: interfacing-with-webassembly-in-go
featured: true
ogImage: >-
  https://user-images.githubusercontent.com/53733092/215771435-25408246-2309-4f8b-a781-1f3d93bdf0ec.png
tags:
  - Go
  - WebAssembly
  - Yoke
description: Experience building a host module in webassembly for yoke
---
It’s no secret that the [Yoke](https://github.com/yokecd/yoke) project is a big fan of WebAssembly.
WebAssembly allows us to compile our code into a single OS- and architecture-agnostic binary.
This compilation process is one way we package our code, making it ready to run safely on any host.

Beyond serving as the package format for Yoke Flights, WebAssembly enables us to execute code within a sandbox,
enforcing strict security guarantees.
When running a WASM module from Go, the module cannot access the host's memory, make syscalls, open file descriptors, or establish network connections.

This ensures that [Yoke](https://github.com/yokecd/yoke) can run WASM Modules securely while preventing potentially untrusted code from compromising your system.

### But if this is true, how can Yoke provide [Cluster Access](https://yokecd.github.io/docs/concepts/cluster-access)?

Cluster Access might seem to contradict everything we just said:

- We don’t want arbitrary code performing unrestricted actions in our cluster.
- If WebAssembly can’t open a socket, how can it communicate with the Kubernetes API?

While these concerns are understandable, they are ultimately unfounded.

Even with Cluster Access, Yoke Flights cannot perform arbitrary actions in your Kubernetes cluster.
And it remains true that a WebAssembly module cannot make network requests to the cluster to interact with it—

At least not directly. Let’s take a closer look at how this works.

## Cluster-Access Behind the Scenes

**WebAssembly System Interface (WASI)** is a standard that enables WASM modules to interact with system resources. As we will see, it allows the module to delegate tasks to the host.

WASM modules are executed by a host program. The most common environment for running WebAssembly is a web browser, but it is far from the only runtime available. Unsurprisingly, Node.js can also run WebAssembly, along with many other runtimes, including:

- Wasmer
- Wasmtime
- Wazero

[Yoke](https://github.com/yokecd/yoke) is built with Go, and so uses [Wazero](https://github.com/tetratelabs/wazero) a pure Go runtime for WASM.

The host runs the WASM module as a guest within its own memory sandbox. It’s similar to a Russian doll, with the host program containing a smaller guest program within itself.

The host can expose functions that the guest can import and call. When the guest WASM module invokes such a function, it yields control back to the host, waits for it to execute the function, and then resumes execution.

<img src="/src/assets/images/interface-with-wasm/host-guest.svg" class="dark:invert" />

> **_INFO:_** From this point onwards the term Host refers to the process running the WebAssembly Runtime.
> Generally, in our case this refers to the Yoke CLI.
> The guest refers to the WebAssembly Module embedded within the Host Process.

If the user explicitly opts in, [Yoke](https://github.com/yokecd/yoke) provides a single function to WASM modules: `k8s_lookup`.  
This function is called by the guest module but executed by the host. This means that the WASM module cannot perform arbitrary actions; it can only invoke the behavior provided by `k8s_lookup`.

## Hurdles

Even though we can provide host functions to the guest, our task is not over yet.  
WebAssembly is, after all, an assembly-like language. It only supports basic numeric types and does not natively support strings or structs.

> **_NOTE:_** WASI Preview 2 introduces the component model, allowing us to define types that both the host and guest can understand.  
> However, [Wazero](https://github.com/tetratelabs/wazero) does not support this yet, opting instead for WASI Preview 1.

Despite these limitations, if we look at the Yoke Cluster-Access API, it appears quite high-level:

```go
package main

import (
  corev1 "k8s.io/api/core/v1"
  "github.com/yokecd/yoke/pkg/flight/wasi/k8s"
)

func main() {
  secret, err := k8s.Lookup[corev1.Secret](k8s.ResourceIdentifier{
    Name:       "shhh",
    Namespace:  "default",
    APIVersion: "v1",
    Kind:       "Secret",
  })

  // ...
}
```

The challenge—and the goal of this blog post—is how to pass complex data types and errors between the host and the guest module.

At this point, it may be useful to examine the signature of the `k8s_lookup` function provided by the host:

```go
//go:wasmimport host k8s_lookup
func lookup(state uint32, name, namespace, kind, apiversion uint64) uint64
```

This may feel like witchcraft—and maybe it is.

The first thing we need to know is that WebAssembly modules use a 32-bit address space.  
This means that any memory address within the module can be represented by a 32-bit integer.

The second thing we need to know is that strings (and by extension, byte slices) can be represented
as a pointer to the start of the string and its length. Hence, a 32-bit integer for the address of the string and a 32-bit integer for the length of the string—or a single 64-bit integer.

The third thing we need to know is that the host program owns the guest module and its memory sandbox.  
This means that the host program can read from the WebAssembly module's memory. If the module declares a string and passes the address and length to the host, the host can read the string from the guest's memory.

Now that we know these facts, the magic behind the function signature starts to fall away.

We can start thinking about those integer types as representing arbitrary data:

```go
package wasm

type String  uint64  // 32-bit Address + 32-bit Length.
type Buffer  uint64  // Buffer is a []byte. Same reasoning as a string applies.
type Pointer uint32  // We can represent any pointer as a 32-bit address.
```

And the `k8s_lookup` function can be rewritten like so:

```go
//go:wasmimport host k8s_lookup
func lookup(state wasm.Pointer, name, namespace, kind, apiversion wasm.String) wasm.Buffer
```

This should now make much more intuitive sense. Given the strings `name`, `namespace`, `kind`, and `apiVersion`, we can look up a Kubernetes resource on the host, serialize it as JSON, and pass it back to the guest as a `[]byte`.

However there are still some details that allude us:

- How do we translate strings from the guest into uint64 integer values for the host to consume?
  - And relatedly how do we read the data from the wasm.Buffer (a uint64) as a `[]byte`?
- How do we return a Buffer from the host to the guest, when the guest cannot reach outside itself to read host memory?
- What is the state pointer and what does it do?

### Translating data to numeric types and back again

#### Guest Perspective

From the perspective of the Guest WebAssembly module, we have strings and buffers that we want to transform into `uint64` values.
The strategy that [Yoke](https://github.com/yokecd/yoke) uses is to represent the address of the string as the first 32 bits, and the length as the last 32 bits:

```go
import "unsafe"

type Buffer uint64

// FromString converts a []byte value into a uint64 representing its address and length.
func FromSlice(buffer []byte) Buffer {
  if len(buffer) == 0 {
    // 0 length slices can be reduced to no value.
    // We cannot take the address of the first element as it does not exist so we represent
    // this as 0.
    return 0
  }
  // Unsafe conversion rules:
  // - Any pointer can be cast to an unsafe.Pointer.
  // - An unsafe.Pointer can be cast to a uintptr
  // - a uintptr is a normal numeric type that can be cast to other numeric types.
  //
  // We know the address will be a 32 bit value since we are in the Guest Space.
  // We therefore left shift into the 32 upper bits of our uint64.
  address := uint64(uintptr(unsafe.Pointer(&buffer[0]))) << 32
  length := uint64(uint32(len(buffer)))
  return Buffer(address | length)
}

// Address returns the address of a buffer as a 32bit integer.
func (buffer Buffer) Address() uint32 {
 return uint32(buffer >> 32)
}

// Address returns the length of a buffer as a 32bit integer.
func (buffer Buffer) Length() uint32 {
 return uint32(buffer)
}

// Slice the data at at the address of the buffer, for the amount of the length of the buffer
// and returns the memory as a []byte.
func (buffer Buffer) Slice() []byte {
  if buffer == 0 {
    // Guard against the 0 length buffers.
    return nil
  }
  return unsafe.Slice(
    (*byte)(unsafe.Pointer(uintptr(buffer.Address()))),
    buffer.Length(),
  )
}
```

Doing the same for the `wasm.String` type maps 1-1 with the `wasm.Buffer` example, and in the spirit of a university textbook,
will be left as an exercise for the reader.

#### Perspective of the Host

We have now seen how to work with Strings and Buffers from the perspective of the guest: just a little unsafe pointer magic.
However the host is slightly different. The guest module assumes that it is the entire world, and as such uses the pointers to variables
and passes those values up to the host. The host on the other hand, needs to interpret those values in the context of the guest's memory space.

With [Wazero](https://github.com/tetratelabs/wazero) this is quite easy since host functions by convention start with a reference to guest module.

Hence we can build helpers to read our values in from the Guest Module's memory.

```go
import "github.com/tetratelabs/wazero/api"

func LoadBuffer(module api.Module, buffer wasm.Buffer) []byte {
  data, ok := module.Memory().Read(value.Address(), value.Length())
  if !ok {
    panic("memory read out of bounds")
  }
  return data
}
```

This leaves us with one final problem from the Host's perspective. How do we return our response to the guest?
We know how to read memory from the guest. However we need to be able to write to the guest. We cannot create a `[]byte`
on the Host and expect the Guest to be able to read from it. The guest cannot see beyond its memory sandbox.

The Host can reach into the Guest, but the Guest cannot reach out into the Host.

Fortunately Go1.24 allows us to export function from our Guest Module to the Host.
This way we can create a simple `malloc` function on the Guest side to create our `wasm.Buffer` of the appropriate size,
give the reference to the Host and let it write the response to it.

In Go, the easiest way to allocate (malloc?) memory, is to `make` a byte slice.

```go
//go:wasmexport malloc
func malloc(size uint32) wasm.Buffer {
  // FromSlice is defined above (if you've forgotten about it).
  return FromSlice(make([]byte, size))
}
```

This allows us to call it from the Host:

```go
// ExportedFunctions take in a variadiac amount of uint64 as arguments and return the same as results.
// This is because Call doesn't know the size of the arguments or results, and so most default to the
// largest possible numeric value it can handle.
//
// module -> api.Module
// data -> the []byte response we wish to write to the guest.
results, err := module.ExportedFunction("malloc").Call(ctx, uint64(len(data)))
if err != nil {
  // if we cannot malloc, let's crash with gumption.
  panic(err)
}

// And finally write to the buffer and return it to the guest!

buffer := wasm.Buffer(results[0])

module.Memory().Write(buffer.Address(), data)

return buffer
```

### Representing Error values

The final point we have left to address, is how do we return our value or an error?

In Go we are allowed to return more than one value. However, we do not have such a luxury when working with WASM.

After all we have read so far about passing around pointers, and allocating memory, and reading it from modules or loading it in via unsafe,
we have all the tools we need to come up with a solution. And in fact there are many possible ways of representing our return values from the
host to the guest. We could create a data type for containing multiple values, or have a type field to indicate what kind of value we have.

Anything would work as long as the host and the guest agree on the convention.

[Yoke](https://github.com/yokecd/yoke) uses a `wasm.State` enum (or as close to an enum as you get in Go) to let the guest know what kind of a return value it is getting.
At the time of writing it looks like this:

```go
type State uint32

const (
 StateOK State = iota
 StateFeatureNotGranted
 StateError
 StateNotFound
 StateUnauthenticated
 StateForbidden
)
```

This allows us to define the state of the host function call, and let the guest interpret the returned buffer accordingly.
Those states resemble HTTP Errors, naturally because the use-case [Yoke](https://github.com/yokecd/yoke) has is to talk to the Kubernetes API.

However they are meant to be generic, common sense, grassfed errors you would expect to see in the wild.
Packages can use these states to build upon their own Error types.

And so we have finally arrived at the mystery of `k8s_lookup` state pointer argument.

The guest create a state variable and passes its pointer to the host.
The host does its logic, and writes the state value to it before returning a result.
If no error occured it can leave it as its zero value: `StateOK`. If an error occured it can set the state to the
most semantically meaningful state for the guest to use.

This allows us create a nice little error creation helper for the host:

```go
func Error(ctx context.Context, module api.Module, ptr Ptr, state State, err string) Buffer {
 mem := module.Memory()
 mem.WriteUint32Le(uint32(ptr), uint32(cmp.Or(state, StateError)))
  // Malloc hasn't been defined above. It is simply a helper over the little "malloc" call we saw above.
  // It allows the host to write data to the module's memory.
 return Malloc(ctx, module, []byte(err))
}
```

We can then use it construct error responses from the host to the guest.

```go
import kerrors "k8s.io/apimachinery/pkg/api/errors"

deployment, err := client.CoreV1().Deployments("default").Get("example", metav1.GetOptions{})
if kerrors.IsNotFound(err) {
  return Error(ctx, module, stateRef, wasm.StateNotFound, err.Error())
}

// Use deployment ...
```

Then the guest simply needs to check the state value, and interpret the data in the returned Buffer accordingly.

## Conclusion

We've seen how Host programs interact with their Guest WebAssembly programs by sharing nothing more than numeric types
and doing pointer slight of hand.

We've seen some of the type abstractions that [Yoke](https://github.com/yokecd/yoke) uses in order to make working with `Strings` and `Buffers` easier to reason about.

Finally we've explored different conventions for reprenting data of different types.

Hopefully this helps you next time you desire to tinker with WebAssembly.

## Post-Word

I, the author, am not an expert at technical writing, nor WebAssembly. If anything feels wrong or can be better expressed
please suggest an edit to this post! Thanks for reading!

