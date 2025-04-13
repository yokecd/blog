---
author: David Desmarais-Michaud
pubDatetime: 2025-28-10T03:00:03.478Z
title: Dynamic Airways -- Redefining Kubernetes Application Lifecycle as Code
slug: dynamic-airways
featured: true
workInProgress: true
tags:
  - Yoke
description: |
  Explore how Yoke transforms Kubernetes application management by enabling type-safe, code-driven workflows.
  This post demonstrates building a dynamic resource system with Yoke's "Dynamic Airways" to tackle real-world scenarios like automated deployment restarts when secrets change --
  all without writing YAML.
---

## Foreword

This blog post is going to be difficult to write.

And that's because the Yoke project is so very cool. When I started writing Yoke, the only thing that I wanted to achieve
was to write the logic I normally would write in helm chart as regular code. Because encoding deployment logic into a template
seems farcical to me. But what ended up happening is that I built an Application-Life cycle management ecosystem for code.

You can say the project got a way from me. And not because I wanted to add features, but because yoke is cool. Something just works.

The end goal of this blog post is to demonstrate a new feature called "Dynamic Airways". However, every time I sat down to write it, it
would come out like a manual in that I would need to build so much context because at this point in time the project is little known.
And I hated that. So instead of writing in the tone of a formal product, and introducing features slowly and giving their rational, I
want to do something different. I want to ask you, the reader to suspend disbelief, and just follow me on this journey towards dynamic airways.
The only thing you need is a burning desire to work in a type-safe environment with actual code. Yes. Code that is code.

With that in mind, let's begin.

## What are we trying to achieve?

We want to demo Dynamic Airways by solving a standard problem in Kubernetes: restarting a deployment when a secret changes.

If you don't know what an Airway is, that's ok. We will get to it later.

First let's define our demo more specifically. The question above is a common question that newcomers to Kubernetes ask.
And just like answers are usually steeped in and complicated by the real world, I want our solution to feel like an abridged version of the real world.

In the real world, secrets are not managed directly by the Kubernetes API, but are kept in secret storage engines such as AWS Secret Manager or Vault.

So let's take a quick detour into secret management, and let's define a common setup.

- Our secrets live in an external-secret-store such as Hashicorp Vault.
- Our deployment wants to use these secrets in its environment variables.

We will then want to write some Application logic to deploy applications that use these secrets, and somehow redeploys if the secret in vault is updated.

But one thing at a time. First we must do the --

## Setup

For our demo, to have this example be self-contained, everything must run inside of a temporary cluster.

For this ephemeral cluster, I will be using Kind. If you don't have Kind yet you can install it via the Go Toolchain or your favourite package manager:

```bash
go install sigs.k8s.io/kind@latest

brew install kind
```

Next we are going to need to install Vault into our cluster. As well as the external-secret-operator (ESO) to get those secrets into regular kubernetes secrets.

With yoke we need to write a program that writes the resources we want back to stdout as json. It sounds like we have already arrived at a dead end. Are we really
going to hand write the code that would return the resources needed to install Vault? And the ESO?

Writing that all from scratch sounds unreasonable. And even I, who has a tendency to rewrite everything from scratch, agree.

So let's use their Helm Charts. But let's not use Helm. I dream of a world in which we don't write Helm Charts anymore, but at this stage it would be denial
to pretend that they don't exist and that we can't use them. If any new package management system is going to succeed, it needs to be able to leverage what
already exists otherwise we have to restart from scratch. Fortunately yoke does so. At least if we stay in the Go ecosystem.

This is because yoke works by compiling programs to WebAssembly. There is no reason we cannot simply compile Helm into our program. We can just embed the charts we need
and execute them by importing Helm. Now obviously there's a lot of leg work and its easier said than done, but the yoke project is dedicated to customer service and has
already handed all of that.

First we start by installing yoke's `helm2go` CLI, which is a script to download a helm chart, generate types for the values file if possible, and output a Go package to
make it as easy as possible to use.

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

For those of you that want to skip ahead and just see the actual code used for the demo, it can be found [here](https://github.com/yokecd/examples/blob/main/demos/dynamic-mode/setup/main.go).
All glorious 120 lines of code that render the Vault and ESO charts, as well as creates a Secret-Store representing our Vault Backend.

But talking about creating our vault secret store backend, we run into an issue. The secret-store backend is a custom resource of the
vault installation. We can only create it after having installed vault. Are we cooked? No because yoke let's us specify our resources in stages
if we want! The output of a flight to stdout can either be a resource, a list of resources, or a list of list of resources in other words stages.

Hence we can install all CRDs before we create any custom resources.

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

So our setup really just boils down to a couple simple steps:

- generate some Go packages for the charts we want to use such as vault and external-secrets-operator.
- render those charts in code to get their resources
- add any other resources we may want in our setup such as vault-token secret or vault-backend secret store
- encode our resources in stages: CRDs first, everything else after.

And now we have a functional setup, ready for us to build applications that use the secrets that we might store in vault.

## Let's build our Application

Before we build our application. Let's discuss the matter of the inputs.
We clearly need to be able to choose the image we want to deploy, and map secrets from vault to our environment.

But beyond that, isn't it tiresome to deploy things into our cluster via helm or yoke? In the sense that our releases
are made from the client-side, and Kubernetes has no native awareness of what we have released.

It would be nice, if our input wasn't just some arbitrary input to the release, but instead a fully fledged Kubernetes API.
Let's postulate that our Application could be something like this:

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

And that Kubernetes would then be able to validate the inputs on our behalf, and set appropriate RBAC rules and so on.

**What a world that would be.**

And with the yoke's air traffic controller this is possible. That is what the mysterious Airway is about.
You build a custom resource definition and point it to a code based implementation via a URL, and the Air Traffic controller
takes care of the rest.

This way you don't need to build your own controller. You just need to focus on reading in your custom resource, and outputting the resources you want.

So let's define our custom resource in code such that its type would match our resource given above.

```go
package v1

import (
 metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

 "github.com/yokecd/yoke/pkg/openapi"
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
 SecretRefreshInternval openapi.Duration `json:"refreshInterval,omitzero"`
}
```

## Implementing our Backend's flight

Next we can create a program that would consume this type and transform it to the resources that we want our package to be.

What should those resources be?

- Definitely a deployment.
- We will need an external-secret.
- We will define a secret (this may seem unnecessary now since external secrets can create secrets for us but this will make more sense later)

So let's start.

First some boilerplate. This is incidentally not yoke specific boilerplate. I write the same lines for almost every single executable Go package I write.

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

Let's add our secret resource. But what do we have as data to put in if our external secret that we plan to add will be driving the show?
The fact of the matter is that we need the secret to be owned by our release for the "dynamic" aspect of airway to work. I won't say more about that for now.
But also, we will want to have the secret so that we can hash its data and use that as a label on our deployment. This way if the secret's data changes, the label changes,
and the deployment restarts.

**But how do we get the secret's data?**

We compile to WebAssembly and so we cannot make arbitrary network calls. However, via the magic of WASI yoke provides the ability to lookup resources in the same release.
So we can actually fetch the secret's data in the cluster. Maybe it'll be better if I just show you.

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

We create a secret using the same name and namespace as our backend instance. For the data, we query the k8s api via our wasi interface.
If there's an error or no data we simply return an empty map. But if the secret exists in the cluster we just reuse the same data for our secret.

Next we will need to hash the secret data. This way we can add a label to our deployment with the hash of our secrets. When a secret is modified, the hash changes and deployment label is updated. This leads to the deployment being restarted.

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

With that we've built all three resources in pure Go:

- A secret that just reads its values from the cluster
- A deployment that contains a hash of the secrets data as a label
- An external secret binding the vault secrets to our kubernetes secret.

All we have left to do is write them as json over stdout:

```go
return json.NewEncoder(os.Stdout).Encode(flight.Resources{deployment, secret, externalSecret})
```

And voila. We have defined the kubernetes resource logic for our backend type.

We simply need to compile it to WebAssembly and host it somewhere.

```bash
GOOS=wasip1 GOARCH=wasm go build -o demos_dynamic_mode_v1_flight.wasm ./demos/dynamic-mode/backend/v1/flight
```

The example repository hosts this binary in a github release.
Although it could have used github container registry and stored it as a container artifact but let's leave that for another day.

## Creating an Airway

By this point, we have most of the things that we need. We have a flight to setup our environment with a Vault instance, and our external-secrets-operator.

We have a type that defines our desired CustomResourceDefinition as well as another program to read in a resource of said type and turn that into subresources.

All that is left is to have that CRD created and bound to its implementing program. Within the context of the yoke Air Traffic Controller, we do this by creating an Airway.

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

However, before we start running commands and experimenting with our cluster, I owe the reader an explanation of what `dynamic` mode is.

Normally when a custom resource instance of a CRD created by an Airway (that's a mouthful) is created, its subresources are created as specified by its flight implementation and the story ends there.
If a user or other third-party actor like a controller modifies one of the subresources nothing happens. No state will be reconciliated until a change to the parent custom-resource is made and a new desired state is to be applied.

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

<div class="notice">
Caveat: there is an option to detect drift on an interval and reset cluster state to desired state but this is not very reactive.**
</div>

However, with dynamic mode, as soon as subresource is modified the entire parent-resource is requeued for evaluation. What's more, when it is reevaluated it does not need to yield the old desired state and can generate a new one.

Which is the complete trick behind all the smokes and mirrors about how we restart our deployment. When the external-secret-operator sees a secret change, it will update the secret which is a subresource of our Backend type we are introducing. Since the backend is owned by a dynamic airway it will be requeued for evaluation and the deployment's label will be updated with a new hash of the secret values. Case closed.

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

# Run this commented command at your leisure to update the deployment by changing the secret in vault.

# VAULT_ADDR=http://localhost:8200 VAULT_TOKEN=root vault kv put secret/demo hello=fromtheotherside
```

## Conclusion

There's a lot to unpack.

Especially given how new yoke is and that our mental model as a community has not shifted from interfacing with Kubernetes as a set of annotated yaml manifests to logic encoded as code.

We wrote a flight that combined two charts by generating code from their chart repositories. And with better typing support than they have. As well as adding resources that we wanted as part of our setup such as the vault secret-store. And we did this by using the actual types from the Vault project. We didn't have to guess as to what structured yaml we needed with what keys. And all of this combined nicely.

We used yoke to deploy our setup in stages, CRDs first and all other resources after. We didn't need annotations to describe post or pre-install hooks.

We defined a type to represent a new custom resource in our cluster and implemented a program to transform a value of that type into the set of resources we want to deploy.
We were able to use hashing functions, for loops and conditionals in a proper type-safe environment.

Our implementation is able to read cluster-state allowing us to respond to changes in our cluster.

We created an Airway to define this CRD to a url of our module we just implemented. We inferred the openapi schema with reflection. We told the ATC to treat this airway as dynamic so that it automatically responds to changes to its subresources and requeues it for evaluation.

And with these components, we are now able to create applications that respond to changes in the cluster and self-adjust.

We did all this without defining anything in yaml, without annotating resources to point at each other like bad C++ pointers for Controllers to do the logic that we can specify ourselves in code.

And I think thats pretty beautiful, and I hope you do too.
