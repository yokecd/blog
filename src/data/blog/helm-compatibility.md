---
author: David Desmarais-Michaud
pubDatetime: 2025-05-07
title: Yoke and Helm Compatibility
slug: helm-compatibility
workInProgress: true
featured: true
tags:
  - yoke
  - helm
description: >
  Yoke wants to pivot away from Helm and YAML templating — but does that mean throwing the baby out with the bathwater?
  Let’s explore how Yoke keeps backwards compatibility with Helm in a code-first world.
---

## Table of Contents

## Charts and Flights – What's the Difference?

At the end of the day, both Helm Charts and Yoke Flights are ways to dynamically package Kubernetes resources.

At an algebraic level, both can be viewed as functions:

```bash
y = f(x)
```

Where the function `f` is the chart or flight, `x` represents the inputs, and `y` is the final set of resources we want to deploy as a single release.

```bash
# With Helm
resources = helm.chart(values.yaml)

# With Yoke
resources = yoke.flight(stdin)
```

From that perspective, working with Helm or Yoke is about transforming inputs into outputs. The difference lies in how we express that transformation function.

The Helm transformation function is the Go template engine. We write a number of YAML files, organized as best we see fit, and define one or more resources per file.

We then use the template engine to express logic: conditionals, loops, and data manipulation via pipelines and Sprig functions to work with strings, maps, and slices.

In my opinion, this feels like the most straightforward approach when you think about Kubernetes as a collection of YAML documents.  
It’s also very practical when your configuration needs are minimal.

But the cracks start to show almost immediately.

- Type support between the `values.yaml` file and your templates isn’t always great.
- Templating sections of resources can get complicated and often requires sub-templates.
- And reusable templates are, by nature, stringly typed.
- Function pipelines can be clunky.
- There’s little type safety for the resources you're building.
- control flow is hard to express.
- white space.
- and so on.

So although we think of Helm as an almost no-code solution, I can't help but feel it’s actually a **poor-code** solution.

## Reaching for a Better Language

What most people reach for at this point is the idea of a better configuration language.

We assume YAML is the problem — that our struggles stem from YAML being bad at expressing configuration.

So we reach for Jsonnet, CUE, or maybe even Apple’s new PKL.

And while I do think these tools generally improve the situation — offering benefits like reduced whitespace sensitivity or better-integrated typing — I still believe they miss the mark.

That’s because, in my view, the problem with Helm Charts isn’t that the _target_ (YAML) is a poor configuration language.  
The real issue is that what we _actually want_ is a good way to express a transformation function. Inputs must lead to outputs.

As a software developer, I can’t help but think that the best way to model a transformation from one type of data to another is... well, a function.

Just a plain, old, imperative, boring-looking function or program. If this, then do that. Our bread and butter.

You might disagree on which language or paradigm is best for expressing this kind of transformation.  
Maybe a functional language like Haskell is ideal — especially for mapping one type to another, from input to output, from standard input to standard output.

Or maybe Rust with its blazing speed and memory safety?

Or Go with its tight integration within the Kubernetes ecosystem?

**And that’s okay.**

The larger point is this: the best tools we have for handling structured data and producing structured output are programming languages.

That’s the position Yoke takes.  
Of course, it wouldn’t be feasible to support just _any_ source code, nor would it be safe to execute arbitrary binaries.

That’s why — as luck would have it — Yoke supports WebAssembly as a shared target for code execution.  
It runs in a safe, sandboxed, and predictable environment.

As long as your programming ecosystem can target WebAssembly, you get first-class support in Yoke.

## A Tale of Two Ecosystems

So now that I’ve convinced a small percentage of readers that maybe what they really want is to develop their transformation functions in a type-safe, powerful development ecosystem — and are ready to make the switch — we have to ask the next hard question:

**What exactly are we buying into? Where is the ecosystem?**

What can I install, practically speaking? We can definitely build new "charts" as "flights".

Some things already exist as Flights hosted by the Yoke project — like its "air traffic controller" or "yokecd", a Yoke-extended version of ArgoCD.  
That said, the Yoke ecosystem is still new. Adoption is, for now, just a dream on the horizon. The ecosystem still has to be built.

But what about the existing Helm ecosystem?  
If I need Helm just to install Redis, is switching to Yoke even worth it?

And what about all the internal Charts we use at our organizations?  
Does everything need to be ported to code on day one in order to start using Yoke?

Are we just so trapped by Helm’s gravitational pull that we can never escape its orbit?

**It sure feels that way.**

But that’s not the whole story.

Yoke recognizes that it has no path forward — not even a snowball’s chance in hell — without some degree of interoperability with Helm.

And fortunately, things just kind of worked out.  
Yoke executes code compiled to WebAssembly to transform inputs into outputs.  
Helm is written in Go.  
Go can be compiled to WebAssembly.

**Yoke can use Helm.**

Let’s be clear: Yoke doesn’t use Helm to do package management or deployment.  
But users can build Flights that embed Helm Charts and execute them to get their desired resources.

This means users can extend, combine, and manipulate Charts however they like.

And — importantly — we can embed our existing Charts into Flights on day one, and _progressively_ port the templating logic over to real code.  
This provides a smooth migration path from Charts to Flights, rather than forcing a hard rewrite.

## Chartered Flights

<div class="notice">
  ⚠️ <span style="font-weight: bold">Warning:</span> The following section contains Go code.  
  As of the time of this post, using Helm in code requires being in the Go ecosystem.  
  However, I have plans to remove this limitation. For more information, see this <a href="https://github.com/yokecd/yoke/issues/126">issue</a>.
</div>

Let’s take a technical deep dive into how this works.

WebAssembly modules do not have access to the filesystem or network.  
That means we need to _embed_ the Chart into our program.

Thankfully, since Go 1.16, this is easy to do using Go's `embed` package:

```go
import "embed"

//go:embed all:chart
var chartFS embed.FS
```

Alternatively, we can embed the `.tgz` artifact downloaded via `helm pull`:

```go
import _ "embed"

//go:embed chart.tgz
var archive []byte
```

Next, we import Yoke’s Helm wrapper and use it to create a chart instance that we can render:

```go
import (
  "github.com/yokecd/yoke/pkg/flight"
  "github.com/yokecd/yoke/pkg/helm"
)

// ...

// Using the embedded chart file system
chart, err := helm.LoadChartFromFS(chartFS)
if err != nil {
  return fmt.Errorf("failed to load chart from embedded FS: %w", err)
}

// Or, if using the .tgz archive:
chart, err := helm.LoadChartFromZippedArchive(archive)
if err != nil {
  return fmt.Errorf("failed to load chart from zipped archive: %w", err)
}
```

We can then invoke the chart using a release name, namespace, and any values we want:

```go
resources, err := chart.Render(
  flight.Release(),
  flight.Namespace(),
  // This value can be any type. It will be marshaled to JSON before being passed to Helm under the hood.
  map[string]any{},
)
```

The `resources` returned are of type:

```go
k8s.io/apimachinery/pkg/apis/meta/v1/unstructured.Unstructured
```

This allows us to work with them in a generic, flexible way.

Finally, we can return the resources as JSON over stdout once we’ve finished manipulating them:

```go
json.NewEncoder(os.Stdout).Encode(resources)
```

## Taking a Peek Under the Hood

So far, everything we've covered has been from the perspective of a user working with Yoke’s wrapper over Helm.

But the truly curious among you might be left wondering:  
**How does Yoke render Helm charts faithfully?**

The answer is simple: Yoke is a Go project. Helm is also a Go project.  
So Yoke just imports Helm directly and wraps it with a small interface to handle loading and rendering chart files.

---

### Step 1: Load the Chart

To load a chart, Yoke uses Helm's chart loader package:

```go
import "helm.sh/helm/v3/pkg/chart/loader"
```

Here's how we unpack a Helm `.tgz` archive into buffered files:

```go
var files []*loader.BufferedFile
for {
  header, err := archive.Next()
  if err == io.EOF {
    break
  }
  if err != nil {
    return nil, fmt.Errorf("failed to iterate through archive: %w", err)
  }

  if header.Typeflag != tar.TypeReg {
    continue
  }

  content, err := io.ReadAll(archive)
  if err != nil {
    return nil, err
  }

  files = append(files, &loader.BufferedFile{
    Name: header.Name,
    Data: content,
  })
}
```

Then we use these buffered files to load a `*chart.Chart` instance:

```go
underlyingChart, err := loader.LoadFiles(files)
```

Then we can return a wrapped version of the Chart.

```go
return Chart{
  chart: underlyingChart,
}
```

---

### Step 2: Add a Render Method to our Wrapped Chart

We wrapped our Chart in order to provide an ergonomic render method:

```go
import (
  "helm.sh/helm/v3/pkg/engine"
  "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

type Chart struct {
  chart *chart.Chart
}

func (c Chart) Render(release, namespace string, values any, opts ...RenderOpt) ([]*unstructured.Unstructured, error) {
	var options renderOpts
	for _, apply := range opts {
		apply(&options)
	}

	releaseOptions := chartutil.ReleaseOptions{
		Name:      release,
		Namespace: namespace,
	}

	if options.IsInstall {
		releaseOptions.IsInstall = true
	} else {
		releaseOptions.IsUpgrade = true
	}

	capabilities := chartutil.DefaultCapabilities.Copy()

	valueMap, err := asMap(values)
	if err != nil {
		return nil, fmt.Errorf("failed to convert values to map: %w", err)
	}

	chartutil.ProcessDependencies(chart.Chart, valueMap)

	valueMap, err = chartutil.ToRenderValues(chart.Chart, valueMap, releaseOptions, capabilities)
	if err != nil {
		return nil, err
	}

  rendered, err := engine.Render(c.chart, valueMap)
  if err != nil {
    return nil, err
  }

  // Parse the resources from the rendered chart...
  // Simple yaml decoding omitted for brevity.

  return resources, nil
}
```

And voila, we've done it.

Yoke exposes an easy way for Go packages to render their embedded Charts into resources they can use in their Flights.

## Conclusion

So what have we learned?

We’ve looked at Helm — for all its strengths — and seen how it starts to fall apart once you outgrow simple configuration.

We’ve talked about how Yoke offers a fresh approach: treating templating not as a special YAML problem, but as a real programming problem. Inputs in, outputs out. Transformation as code.

This shift in perspective gifts us strong typing, real tooling, actual debuggers, and the freedom to express our logic in the language of our choice (as long as it compiles to WebAssembly).

And we’ve addressed the elephant in the room: Helm’s massive gravitational pull.

But instead of pretending Helm doesn’t exist, Yoke embraces it.

You can embed Charts. You can render them. You can gradually migrate them.

It’s not all-or-nothing. It’s not rewrite-everything-on-day-one:
**Yoke is about opening the escape hatch — not slamming the door shut.**

There’s still work to do. The yoke ecosystem is young.

But if you believe Kubernetes resource management is important enough to deserve a better programming environment than a text engine, maybe it’s time to give Yoke a try.

