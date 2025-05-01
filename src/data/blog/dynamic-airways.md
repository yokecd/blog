---
author: David Desmarais-Michaud
pubDatetime: 2025-04-30
title: Dynamic Airways -- Redefining Kubernetes Application Lifecycle as Code
slug: dynamic-airways
featured: true
tags:
  - Yoke
description: >
  Explore how Yoke transforms Kubernetes application management by enabling type-safe, code-driven workflows.
  This post demonstrates building a dynamic resource system with Yoke's "Dynamic Airways" to tackle real-world scenarios like automated deployment restarts when secrets change --
  all without writing YAML.
---

<style>
  .notice {
    color: orange;
    border: 2px solid orange;
    border-radius: 5px;
    font-size: 0.9em;
    font-style: italic;
    padding: 5px 10px;
  }
</style>

## Foreword

This blog post is going to be difficult to write.

That’s because the Yoke project has grown far beyond what I originally envisioned. When I started working on Yoke, my only goal was to write the kind of logic I’d normally cram into a Helm chart—but as regular code. Because honestly, encoding deployment logic into a template feels farcical to me.

But somewhere along the way, Yoke became something more. I accidentally built a Kubernetes Resource Management Ecosystem—as Code.

You could say the project got away from me.

And not because I was chasing features for the sake of it, but because Yoke is just… cool. Something about it clicks, and it keeps building on itself.

The point of this blog post is to introduce a new feature called Dynamic Airways. But every time I tried to write about it, it ended up sounding like a manual—because I felt the need to explain everything from the ground up. The project isn’t widely known yet, and that pressure to explain every detail? I hated it.

So I’m doing something different.

Instead of presenting this like a formal product announcement—explaining features one by one and justifying each design choice—I want to try a different approach. I want to ask you, the reader, to suspend disbelief and come along for the ride as we head toward Dynamic Airways.

All you need is a burning desire to break away from the current status quo and work in a type-safe environment with actual code. Yes. Code that is code.

With that in mind, let’s begin.

## A Word on Terminology

Actually, hit the brakes before we start. We need a quick word on naming.

Naming things is hard. And unfortunately, with Yoke, a lot of things are new—and new is not always easy.

To make things a little less confusing, here’s a quick primer on terms you may come across.

Context: Helm is named after the steering wheel of a naval ship. Yoke, on the other hand, is the steering component of an airplane.

That’s why Helm calls its packages **Charts**, and Yoke calls its packages **Flights**.

With that in mind, here’s a quick glossary to help make sense of some of the terms used in this article:

- **Flights**: Programs that read from `stdin` and write Kubernetes resources to `stdout`. Usually compiled to WebAssembly.
- **Air Traffic Controller (ATC)**: The server-side controller included in the Yoke project. It watches for `Airway` resources and executes Flights.
- **Airways**: A `CustomResource` provided by the Yoke project when the ATC is installed. It defines a `CustomResourceDefinition` and binds it to a corresponding Flight.

## What are we trying to achieve?

We want to demo Dynamic Airways by solving a classic Kubernetes problem: restarting a deployment when a secret changes.

If you don’t know what an Airway is yet, that’s totally fine—we’ll get to it shortly. For now it should be sufficient to say that an Airway is akin to a CRD
that represents an Application we want to deploy.

First, let’s define our demo a bit more clearly. The question above is a common one that newcomers to Kubernetes often ask. And just like most real-world answers, the solution tends to be steeped in complexity and messy details. What I want instead is for our solution to feel like an abridged version of reality—real enough to make sense, but streamlined for clarity.

In the real world, secrets usually aren’t managed directly in Kubernetes. One common approach is to store them in dedicated secret management systems like AWS Secrets Manager or HashiCorp Vault.

So let’s take a quick detour into secret management and outline a typical setup:

- Our secrets live in an external secret store, like HashiCorp Vault.
- Our application wants to use these secrets as environment variables.

Our goal is to write some application logic that can deploy an app using these secrets—and, crucially, redeploy it automatically when our external secret is updated.

But one thing at a time. First we must do the --

## Setup

<div class="notice">
  All the code for the demo can be found unabridged within yoke's <a href="https://github.com/yokecd/examples">examples</a> repository.
</div>

For this demo to be self-contained, everything needs to run inside a temporary Kubernetes cluster.

We'll use [Kind](https://kind.sigs.k8s.io/) for that. If you don’t have Kind installed, you can grab it via the Go toolchain or your favorite package manager:

```bash
# via Go
go install sigs.k8s.io/kind@latest

# alternatively
brew install kind
```

Next, we need to install [Vault](https://www.hashicorp.com/en/products/vault) into our cluster, along with the [External Secrets Operator](https://external-secrets.io/latest/) (ESO) to sync those external secrets into standard Kubernetes Secret resources.

At this point, you might be wondering: with Yoke, we’re supposed to write a program that emits the Kubernetes resources we want as JSON to stdout. That sounds great… until you realize we’d need to handwrite all the code required to install Vault and ESO.

That’s not just tedious—it’s unreasonable. And even I, someone with a strong tendency to rewrite everything from scratch, is forced to agree.

So instead, let’s use their Helm charts.

But—wait—we’re not going to use Helm.

I dream of a world where we don’t write Helm charts anymore. But let’s be real: they exist, they work, and pretending they don’t would be pure denial. If any new package management system is going to succeed, it must be able to leverage what’s already out there. Otherwise, we’re forced to start from zero.

Fortunately, Yoke does just that—especially if you stay within the Go ecosystem.

Yoke works by executing WebAssembly (wasm) modules that are nothing more than programs that read inputs from stdin and write desired resources to stdout.

So there’s no reason we can’t simply compile Helm into our program. This is the freedom that using code provides us with.

We can embed the charts we need and invoke them directly via Go. Obviously, there’s a lot of plumbing involved, and it’s easier said than done—but Yoke is a project dedicated to developer experience. That heavy lifting? Already handled.

We’ll start by installing Yoke’s helm2go CLI. It’s a tool that fetches a Helm chart, generates Go types for its values (when possible), and produces a Go package with the helm chart embedded within to make it as seamless as possible to use.

```bash
# install helm2go
go install github.com/yokecd/yoke/cmd/helm2go@latest

# generate the package:
helm2go -outdir ./charts/vault -repo https://helm.releases.hashicorp.com/vault
```

This should generate something that looks like this:

```go
package vault

import (
 _ "embed"
 "fmt"

 "k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"

 "github.com/yokecd/yoke/pkg/helm"
)

//go:embed vault-0.30.0.tgz
var archive []byte

// RenderChart renders the chart downloaded from https://helm.releases.hashicorp.com/vault
// Producing version: 0.30.0
func RenderChart(release, namespace string, values *Values) ([]*unstructured.Unstructured, error) {
 chart, err := helm.LoadChartFromZippedArchive(archive)
 if err != nil {
  return nil, fmt.Errorf("failed to load chart from zipped archive: %w", err)
 }

 return chart.Render(release, namespace, values)
}
```

With types generated from the charts jsonschema:

```go
// Code generated by github.com/atombender/go-jsonschema, DO NOT EDIT.

package vault

type Values struct {
 // Csi corresponds to the JSON schema field "csi".
 Csi *ValuesCsi `json:"csi,omitempty" yaml:"csi,omitempty" mapstructure:"csi,omitempty"`

 // Global corresponds to the JSON schema field "global".
 Global *ValuesGlobal `json:"global,omitempty" yaml:"global,omitempty" mapstructure:"global,omitempty"`

 // Injector corresponds to the JSON schema field "injector".
 Injector *ValuesInjector `json:"injector,omitempty" yaml:"injector,omitempty" mapstructure:"injector,omitempty"`

 // Server corresponds to the JSON schema field "server".
 Server *ValuesServer `json:"server,omitempty" yaml:"server,omitempty" mapstructure:"server,omitempty"`

 // ServerTelemetry corresponds to the JSON schema field "serverTelemetry".
 ServerTelemetry *ValuesServerTelemetry `json:"serverTelemetry,omitempty" yaml:"serverTelemetry,omitempty" mapstructure:"serverTelemetry,omitempty"`

 // Ui corresponds to the JSON schema field "ui".
 Ui *ValuesUi `json:"ui,omitempty" yaml:"ui,omitempty" mapstructure:"ui,omitempty"`
}

// ... Continued ...
```

Now installing Vault using a Yoke Flight that uses the Vault chart is as simple as writing:

```go
package main

import (
  "github.com/yokecd/examples/demos/dynamic-airway/charts/vault"
  "github.com/yokecd/yoke/pkg/flight"
)

func main() {
  // Ignore error for brevity
  resources, _ := vault.RenderChart(flight.Release(), flight.Namespace(), &vault.Values{})

  json.NewEncode(os.Stdout).Encode(resources)
}
```

We can do the same for the External-Secrets-Operator chart, and execute both charts in a single program.

```go
vaultResources, err := vault.RenderChart(flight.Release()+"-vault", flight.Namespace(), &cfg.Vault)
if err != nil {
  return fmt.Errorf("failed to render vault chart: %v", err)
}

esoResources, err := eso.RenderChart(flight.Release()+"-eso", flight.Namespace(), &cfg.ESO)
if err != nil {
  return fmt.Errorf("failed to render eso chart: %v", err)
}

var resources flight.Resources
for _, resource := range append(vaultResources, esoResources...) {
  resources = append(resources, resource)
}
```

With the combination of these two charts, we have a decent base for our setup. One last thing we may want to add is a vault external secrets `SecretStore` and a secret for its authenticating with it.

```go
vaultTokenSecret := &corev1.Secret{
  TypeMeta: metav1.TypeMeta{
    APIVersion: "v1",
    Kind:       "Secret",
  },
  ObjectMeta: metav1.ObjectMeta{
    Name: "vault-token",
  },
  // In out simplified local example, we are running vault in dev mode, hence the token is simply "root".
  StringData: map[string]string{"token": "root"},
  Type:       corev1.SecretTypeOpaque,
}

// v1beta1 corrresponds to the package: github.com/external-secrets/external-secrets/apis/externalsecrets/v1beta1
vaultBackend := &v1beta1.SecretStore{
  TypeMeta: metav1.TypeMeta{
    APIVersion: v1beta1.SchemeGroupVersion.Identifier(),
    Kind:       "SecretStore",
  },
  ObjectMeta: metav1.ObjectMeta{
    Name: "vault-backend",
  },
  Spec: v1beta1.SecretStoreSpec{
    Provider: &v1beta1.SecretStoreProvider{
      Vault: &v1beta1.VaultProvider{
        Server:  fmt.Sprintf("http://%s-vault:8200", flight.Release()),
        Path:    ptr.To("secret"),
        Version: v1beta1.VaultKVStoreV2,
        Auth: &v1beta1.VaultAuth{
          TokenSecretRef: &esmeta.SecretKeySelector{
            Name: "vault-token",
            Key:  "token",
          },
        },
      },
    },
  },
}

// And we add them to the list of resources we want to output from our flight!
resources = append(resources, vaultTokenSecret, vaultBackend)
```

For those of you who want to skip ahead and just see the actual code used in the demo, you can find it [here](https://github.com/yokecd/examples/blob/main/demos/dynamic-mode/setup/main.go).

All glorious 120 lines of code—rendering the Vault and ESO charts, and creating a `SecretStore` to represent our Vault backend.

But speaking of that Vault `SecretStore` backend, we run into a bit of a problem.

The `SecretStore` resource is a _custom resource_ defined by the Vault installation. That means we can only create it _after_ Vault—and its CRDs—are installed. Are we cooked? (I’m probably too old to say that, but I try.)

Nope—because Yoke lets us specify our resources in **stages**!

The output of a Yoke flight to `stdout` can be:

- A single resource,
- A list of resources,
- **Or** a list of lists of resources—in other words, _stages_.

We’re no longer confined by Helm’s flimsy `preInstall`/`postInstall` hook annotations. We can explicitly control ordering and ensure that CRDs land before the custom resources that depend on them.

So yes, we can install all CRDs _first_, and only then create the custom resources like `SecretStore`. Crisis averted.

```go
 var crds, other flight.Resources
 for _, resource := range resources {
  if resource.GroupVersionKind().Kind == "CustomResourceDefinition" {
   crds = append(crds, resource)
  } else {
   other = append(other, resource)
  }
 }

 return json.NewEncoder(os.Stdout).Encode(flight.Stages{crds, other})
```

So our setup really just boils down to a few simple steps:

- Generate some Go packages for the charts we want to use, like Vault and the External Secrets Operator.
- Render those charts in code to get their resources.
- Add any other resources we need for our setup, such as a `vault-token Secret` and `SecretStore` for our Vault backend.
- Encode our resources in **stages**: CRDs first, everything else after.

And just like that, we have a functional setup—ready for us to build applications that use secrets stored in Vault.

## Let's Build Our Application

Before we build our application, let’s take a moment to talk about inputs.

Clearly, we need to be able to choose the image we want to deploy, and we need a way to map secrets from Vault into our application’s environment.

But beyond that—doesn’t it feel a little awkward that deploying things into the cluster via Helm or Yoke happens entirely from the _client side_? Kubernetes itself has no native awareness of what we’ve released.

Wouldn’t it be nicer if our input wasn’t just some arbitrary values file or CLI argument, but instead a fully-fledged Kubernetes API resource?

That way, Kubernetes could validate our inputs on our behalf, enforce schema correctness, and even let us set up proper RBAC rules around who can create or modify these resources.

Let’s postulate that our `Application` could look something like this:

```yaml
apiVersion: examples.com/v1
kind: Backend
metadata:
  # Calling it proxy cause we are gonna deploy nginx. Just to simulate something real-ish.
  name: proxy
spec:
  image: nginx:latest
  replicas: 2
  SecretRefreshInternval: 5s
  secrets:
    # Env var name DEMO.
    DEMO:
      # The path to the secret in our vault instance.
      path: secret/demo
      key: hello
```

**What a world that would be.**

And with Yoke’s _Air Traffic Controller_, this is actually possible. That’s what the mysterious _Airway_ is all about.

You define a Custom Resource Definition (CRD) and point it to a code-based implementation via a URL. From there, the Air Traffic Controller takes care of the rest.

No need to write your own controller from scratch. You just focus on reading your custom resource and outputting the Kubernetes resources you want in response.

So let’s define our custom resource in code, making sure its type matches the `Application` resource we sketched out above.

```go
package v1

import (
  metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
  APIVersion  = "examples.com/v1"
  KindBackend = "Backend"
)

// Backend is the type representing our CustomResource.
// It contains Type and Object meta as found in typical kubernetes objects and a spec.
type Backend struct {
  metav1.TypeMeta   `json:",inline"`
  metav1.ObjectMeta `json:"metadata,omitzero"`
  Spec              BackendSpec `json:"spec"`
}

type Secrets map[string]struct {
  Path string `json:"path"`
  Key  string `json:"key"`
}

// Our Backend Specification
type BackendSpec struct {
  Image                  string           `json:"image"`
  Replicas               int32            `json:"replicas"`
  Secrets                Secrets          `json:"secrets,omitempty"`
  SecretRefreshInternval metav1.Duration  `json:"refreshInterval,omitzero"`
}
```

## Implementing Our Backend's Flight

Next, we can create a program that consumes this type and transforms it into the resources that we want our package to produce.

What should those resources be?

- Definitely a deployment.
- We will need an external secret.
- We'll also define a secret (this might seem unnecessary right now, since external secrets can create secrets for us, but it will make more sense later).

So let’s get started.

First, some boilerplate. Incidentally, this isn’t Yoke-specific boilerplate—it's the kind of setup I write for almost every executable Go package I create.

```go
package main

import (
  "fmt"
  "os"

  "k8s.io/apimachinery/pkg/util/yaml"
)

func main() {
  if err := run(); err != nil {
    fmt.Fprintln(os.Stderr, err)
    os.Exit(1)
  }
}

func run() error {
  var backend v1.Backend
  if err := yaml.NewYAMLToJSONDecoder(os.Stdin).Decode(&backend); err != nil && err != io.EOF {
    return fmt.Errorf("failed to decode backend: %v", err)
  }

  // Our code goes here!

  return nil
}
```

Let’s add our secret resource. But what data do we put in it if our external secret (which we plan to add) is driving the show?

The truth is, we need the secret to be owned by our release for the "dynamic" aspect of Airway to work. I won’t say more about that for now.

But we also want the secret so that we can hash its data and use that hash as a label on our deployment. This way, if the secret’s data changes, the label will change, and the deployment will restart.

**But how do we get the secret’s data?**

We compile to WebAssembly, so we can't make arbitrary network calls. However, thanks to the magic of WASI, Yoke provides the ability to look up resources within the same release.

In other words, we can actually fetch the secret’s data from within the cluster. But instead of talking about it, maybe it’s better if I just show you.

```go
// We include this import from the yoke project which contains our high-level wasi api for kubernetes.
import "github.com/yokecd/yoke/pkg/flight/wasi/k8s"

// ... back to our run function and the secret ...

secret := &corev1.Secret{
  TypeMeta: metav1.TypeMeta{
    APIVersion: "v1",
    Kind:       "Secret",
  },
  ObjectMeta: metav1.ObjectMeta{
    Name:      backend.Name,
    Namespace: backend.Namespace
  },
  Data: func() map[string][]byte {
    value, err := k8s.Lookup[corev1.Secret](k8s.ResourceIdentifier{
      Name:       backend.Name,
      Namespace:  backend.Namespace,
      Kind:       "Secret",
      ApiVersion: "v1",
    })
    if err != nil || value == nil {
      return map[string][]byte{}
    }
    return value.Data
  }(),
}
```

We create a secret using the same name and namespace as our _Backend_ instance. For the data, we query the Kubernetes API via our WASI interface.

If there’s an error or no data is returned, we simply return an empty map. But if the secret exists in the cluster, we reuse the same data for our secret.

Next, we need to hash the secret data. This will allow us to add a label to our deployment using the hash of the secret. When the secret is modified, the hash changes, and the deployment label is updated. This triggers a restart of the deployment.

```go
secretHash := func() string {
  hash := sha1.New()
  for _, key := range slices.Sorted(maps.Keys(secret.Data)) {
    hash.Write(secret.Data[key])
  }
  return hex.EncodeToString(hash.Sum(nil))
}()

labels := map[string]string{"secret-hash": secretHash}

maps.Copy(labels, selector)

deployment := &appsv1.Deployment{
  TypeMeta: metav1.TypeMeta{
    APIVersion: appsv1.SchemeGroupVersion.Identifier(),
    Kind:       "Deployment",
  },
  ObjectMeta: metav1.ObjectMeta{
    Name: backend.Name,
  },
  Spec: appsv1.DeploymentSpec{
    Replicas: &backend.Spec.Replicas,
    Selector: &metav1.LabelSelector{MatchLabels: selector},
    Template: corev1.PodTemplateSpec{
      ObjectMeta: metav1.ObjectMeta{
        Labels: labels,
      },
      Spec: corev1.PodSpec{
        Containers: []corev1.Container{
          {
            Name:  backend.Name,
            Image: backend.Spec.Image,
            Env: func() []corev1.EnvVar {
              var result []corev1.EnvVar
              for name, value := range backend.Spec.Secrets {
                result = append(result, corev1.EnvVar{
                  Name: name,
                  ValueFrom: &corev1.EnvVarSource{
                    SecretKeyRef: &corev1.SecretKeySelector{
                      LocalObjectReference: corev1.LocalObjectReference{Name: secret.Name},
                      Key:                  value.Key,
                    },
                  },
                })
              }
              return result
            }(),
          },
        },
      },
    },
  },
}
```

Lastly all we have left to describe is our external-secret.

```go
externalSecret := &eso.ExternalSecret{
  TypeMeta: metav1.TypeMeta{
    APIVersion: "external-secrets.io/v1beta1",
    Kind:       "ExternalSecret",
  },
  ObjectMeta: metav1.ObjectMeta{
    Name: backend.Name,
  },
  Spec: eso.ExternalSecretSpec{
    RefreshInterval: func() *metav1.Duration {
      if backend.Spec.SecretRefreshInternval.Duration > 0 {
        return &backend.Spec.SecretRefreshInternval
      }
      return &metav1.Duration{Duration: 5 * time.Second}
    }(),
    SecretStoreRef: eso.ExternalSecretStoreRef{
      Name: "vault-backend",
      Kind: "SecretStore",
    },
    Target: eso.ExternalSecretTarget{
      Name:           secret.Name,
      CreationPolicy: "Merge",
    },
    Data: func() []eso.ExternalSecretData {
      var result []eso.ExternalSecretData
      for _, value := range backend.Spec.Secrets {
        result = append(result, eso.ExternalSecretData{
          SecretKey: value.Key,
          RemoteRef: eso.RemoteRef{
            Key:      value.Path,
            Property: value.Key,
          },
        })
      }
      return result
    }(),
  },
}
```

With that, we’ve built all three resources in pure Go:

- A secret that reads its values from the cluster.
- A deployment that includes a hash of the secret’s data as a label.
- An external secret that binds the Vault secrets to our Kubernetes secret.

All that's left is to write them as JSON to stdout:

```go
return json.NewEncoder(os.Stdout).Encode(flight.Resources{deployment, secret, externalSecret})
```

And voila. We have defined the Kubernetes resource logic for our Backend type.

We simply need to compile it to WebAssembly and host it somewhere.

```bash
GOOS=wasip1 GOARCH=wasm go build -o demos_dynamic_mode_v1_flight.wasm ./demos/dynamic-mode/backend/v1/flight
```

The [examples](https://github.com/yokecd/examples) repository hosts this binary in a [github release](https://github.com/yokecd/examples/releases/tag/latest).

<div class="notice">
  We could have chose to use a container registry and store the wasm module as a container artifact but let's leave that for another day.
</div>

Hence, we have defined our logic, compiled it, and published it to a public location.

## Creating an Airway

By this point, we have most of the things we need. We have a flight to set up our environment with a Vault instance and our External Secrets Operator.

We have a type that defines our desired CustomResourceDefinition (CRD), along with another program that reads in a resource of that type and transforms it into the necessary subresources.

All that’s left is to create the CRD and bind it to its implementing program. In the context of Yoke's _Air Traffic Controller_, we do this by creating an _Airway_.

```go
package main

import (
	"encoding/json"
	"os"
	"reflect"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"github.com/yokecd/yoke/pkg/apis/airway/v1alpha1"
	"github.com/yokecd/yoke/pkg/openapi"

	v1 "github.com/yokecd/examples/demos/dynamic-mode/backend/v1"
)

func main() {
	json.NewEncoder(os.Stdout).Encode(v1alpha1.Airway{
		TypeMeta: metav1.TypeMeta{
			APIVersion: v1alpha1.APIVersion,
			Kind:       v1alpha1.KindAirway,
		},
		ObjectMeta: metav1.ObjectMeta{
			// This name will be reused when creating the CRD and so must follow the same rules as CRD naming.
			Name: "backends.examples.com",
		},
		Spec: v1alpha1.AirwaySpec{
			WasmURLs: v1alpha1.WasmURLs{
				// We bind our CRD to our implementation described above that we are hosting as a github release.
				Flight: "https://github.com/yokecd/examples/releases/download/latest/demos_dynamic_mode_v1_flight.wasm.gz",
			},
			// We set the mode to dynamic. An explanation will be forthcoming.
			Mode: v1alpha1.AirwayModeDynamic,
			// ClusterAccess is opt-in, and we want to use it to be able to read secret-data from the cluster.
			ClusterAccess: true,
			// What's nice here is that the template is just a regular run of the mill CustomResourceDefinitionSpec
			Template: apiextensionsv1.CustomResourceDefinitionSpec{
				Group: "examples.com",
				Names: apiextensionsv1.CustomResourceDefinitionNames{
					Plural:     "backends",
					Singular:   "backend",
					ShortNames: []string{"be"},
					Kind:       "Backend",
				},
				Scope: apiextensionsv1.NamespaceScoped,
				Versions: []apiextensionsv1.CustomResourceDefinitionVersion{
					{
						Name:    "v1",
						Served:  true,
						Storage: true,
						Schema: &apiextensionsv1.CustomResourceValidation{
							// We want our API to be typed and validated by Kubernetes. But why write out the type by hand
							// when we've already spent our effort defining it in Go?
							// Thankfully the yoke project allows us to reflect over a type and builts its schema for us.
							OpenAPIV3Schema: openapi.SchemaFrom(reflect.TypeFor[v1.Backend]()),
						},
					},
				},
			},
		},
	})
}
```

And with this piece of code, we are off to the races.

However, before we start running commands and experimenting with our cluster, I owe you an explanation of what _dynamic_ mode actually is.

Normally, when a custom resource instance of a CRD created by an Airway (that’s a mouthful!) is created, its subresources are created as specified by its flight implementation, and the story ends there.

If a user or another third-party actor, like a controller, modifies one of the subresources, nothing happens. No state will be reconciled until a change to the parent custom resource is made and a new desired state is applied.

<div class="notice">
Caveat: there is an option to detect drift on an interval and reset cluster state to desired state but this is not very reactive.**
</div>

However, with _dynamic_ mode, as soon as a subresource is modified, the entire parent resource is requeued for evaluation. What’s more, when it is reevaluated, it doesn’t need to yield the old desired state—it can generate a new one.

And that's the complete trick behind all the smokes and mirrors that allow us to restart our deployment. When the External Secrets Operator sees a secret change, it updates the secret, which is a subresource of our `Backend` type. Since the `Backend` is owned by a dynamic Airway, it gets requeued for evaluation. The deployment's label will then be updated with a new hash of the secret's values. Case closed.

## Running it.

Now its time for our favourite part. Actually running it.

Let's create a laundry list of steps:

1. Create a temporary cluster for demo purposes.
2. Run our setup via yoke which will install vault and external-secrets-operator.
3. Install the Air Traffic Controller.
4. Open a port-forward to vault and create a secret via the Vault-CLI.
5. Create our Airway.
6. Create an instance of our Backend type.
7. Modify the secret and watch the deployment restart.

No time like the present!

This script can be found in the examples repository and assumes you are executing it from the root.

```bash
CLUSTER=demo-dynamic-mode

# Create a temporary demo cluster
kind delete cluster --name=$CLUSTER && kind create cluster --name=$CLUSTER

# Build and execute our setup -- install vault and external-secrets-operator.
GOOS=wasip1 GOARCH=wasm go build -o ./demos/dynamic-mode/build-artifacts/secretp.wasm ./demos/dynamic-mode/setup
yoke takeoff --debug --wait 5m demo ./demos/dynamic-mode/build-artifacts/setup.wasm

# Install the AirTrafficController using its latest OCI image.
yoke takeoff --debug --wait 2m --namespace atc --create-namespace atc oci://ghcr.io/yokecd/atc-installer:latest

# Open a port-forward to vault and create a a secret for our demo with hello=world Key-Value.
export VAULT_ADDR=http://localhost:8200
export VAULT_TOKEN=root

kubectl port-forward svc/demo-vault 8200:8200 &

sleep 1
vault kv put secret/demo hello=world

# Create our airway. We could have compiled it to wasm first, but given that the flight was completely static
# and did not depend on the release name or env, it is the same as just executing it and piping it to yoke.
# All roads lead to Rome.
go run ./demos/demo-dynamic-modede/airway | yoke takeoff -debug -wait 1m demo-airway

# Create a Backend corresponding to the airway we just created.
# Notice that we are mapping a secret into our deployment --
# Environment variable DEMO will the key hello found at secret/demo in vault.
kubectl apply -f - <<EOF
apiVersion: examples.com/v1
kind: Backend
metadata:
  name: demo-backend
spec:
  image: nginx:latest
  replicas: 2
  secrets:
    DEMO:
      path: secret/demo
      key: hello
EOF
```

If we modify the vault secret that our `Backend` points to, we shall see the deployment restart on its own!

```bash
VAULT_ADDR=http://localhost:8200 VAULT_TOKEN=root vault kv put secret/demo hello=fromtheotherside
```

## Conclusion

There’s a lot to unpack here.

Especially given how new Yoke is and how our collective mental model as a community has yet to shift from interfacing with Kubernetes via a set of annotated YAML manifests to logic that’s encoded as code.

We wrote a flight that combined two charts by generating code from their chart repositories. And we did it with better typing support than those charts have, while also adding resources we wanted as part of our setup—like the Vault `SecretStore`. We did all of this using the actual types from the Vault project. No need to guess what structured YAML we needed or what keys to use. And it all combined together seamlessly.

We used Yoke to deploy our setup in stages—CRDs first, and all other resources afterward. We didn’t need to rely on annotations to describe post- or pre-install hooks.

We defined a type to represent a new custom resource in our cluster and implemented a program to transform a value of that type into the resources we want to deploy. We were able to use hashing functions, loops, and conditionals in a proper type-safe environment.

Our implementation is able to read cluster state, allowing us to respond to changes in our cluster.

We created an Airway to define this CRD, pointing it to the URL of our module. We inferred the OpenAPI schema with reflection. We instructed the Air Traffic Controller (ATC) to treat this Airway as dynamic so that it automatically responds to changes in its subresources and requeues itself for evaluation.

With these components, we can now create applications that respond to changes in the cluster and self-adjust.

And we did all of this without defining anything in YAML, without annotating resources to point at each other like bad C++ pointers for controllers to perform logic that we can now specify ourselves in code.

And I think that’s pretty beautiful. I hope you do too.

## TL;DR

In this post, we use **Yoke** to solve a common Kubernetes problem: restarting a deployment when a secret changes.

We:

- Spun up a local cluster using **Kind**.
- Installed **Vault** and **External Secrets Operator** using Helm charts, without actually using Helm—thanks to Yoke's `helm2go`.
- Wrote a **Flight** in Go to generate our resources as code, rather than YAML.
- Created a **custom resource definition (CRD)** that defines how we want to deploy applications.
- Used **dynamic Airway mode** so that when the secret changes, our deployment auto-updates based on a hash of its contents.
- Avoided writing controllers or managing hook annotations—because Yoke's _Air Traffic Controller_ handles reactivity for us when using _dynamic mode Airways_.

All of this happened in typed Go code, compiled to WebAssembly, and orchestrated through Yoke’s Air Traffic Controller.

No YAML. No brittle annotations. Just actual logic in code.
