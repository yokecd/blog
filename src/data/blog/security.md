---
author: David Desmarais-Michaud
pubDatetime: 2026-04-15
title: "Yoke and Security: A Lesson of Sorts"
slug: module-provenance
featured: true
tags:
  - yoke
  - security
description: >
  Yoke received its first CVE. We walk through the vulnerability, why the RCE framing was overblown, and what we shipped, checksum support, digest pinning, code signing, and allow-listing, giving you real module provenance guarantees.
---

## Table of Contents

## Introduction

As the meme goes, security is so hot right now, and Yoke is not immune.

Recently the Yoke project saw its first big CVE. As the lead maintainer, it was kind of anxiety-inducing to think my code could be making folks' clusters less safe — and also, on the other hand, kind of an honour. A rite of passage for any project worth its salt.

Here it is: [CVE](https://github.com/yokecd/yoke/security/advisories/GHSA-wj8p-jj64-h7ff).

In this post, we are going to walk through what the issue is, how it could be exploited, and what we've shipped to Yoke so that you can sleep at night, if we still can.

## The Issue

Yoke at its core is an alternative to Helm and is a Kubernetes package manager. The major difference is the package format.

Instead of the package being a collection of templated YAML manifests to be invoked with some values, praying that our brush strokes on this text canvas yield proper YAML and valid configuration, we package actual code as WebAssembly.

This allows us to build the logic and validation we want explicitly, leveraging your language's full ecosystem and standard library. Go, for argument's sake.

However, it does frighten the security-minded. A Turing-complete language? Arbitrary code execution? Should we be ringing alarm bells? Walking in an ordered line to the fire escape?

For now let's leave a little suspense and address that later, because the CVE in question is not really about Wasm at all, but about a breakdown in defense through RBAC.

The Yoke project also ships a server-side component called the Air-Traffic-Controller, which allows users to deploy Flights as custom resources, or to extend their cluster with custom resource definitions that bind to a Flight and Wasm module. This enables releases to be managed via Kubernetes resources rather than client-side over the command line.

Yoke Flights are what charts are to Helm: package definitions. In practice, a Flight is just a Wasm module that reads inputs over stdin and outputs Kubernetes resources over stdout.

> Analogy corner:
> - The Flight custom resource is similar to a Flux HelmRelease resource
> - The Airway custom resource is similar to a KRO ResourceGraphDefinition or Crossplane Composition resource.
>   - A CustomResourceDefinition is created in your cluster, allowing you to expose new APIs for your users to consume and deploy applications that way.

Here are examples of resources you might deploy:

```yaml
# a Flight
apiVersion: yoke.cd/v1alpha1
kind: Flight
metadata:
  name: redis
spec:
  wasmUrl: oci://registry/redis-module:v1.2.3 # a url to a fictitious oci registry where a flight that deploys redis might live.
  inputObject:
    # values configuring my flight that will be passed as JSON over stdin to the module when invoked.
---
# An Airway:
apiVersion: yoke.cd/v1lapha1
kind: Airway
metadata:
  name: applications.myorg.domain
spec:
  wasmUrls:
    flight: oci://my-registry/applications:v1.0.0
  template:
    group: myorg.domain
    names:
      kind: Application
      singular: application
      plural: applications
    versions:
      - name: v1
        served: true
        storage: true
        schema:
          openAPIV3Schema:
            # ... The schema (can be generated using yoke packages from Go types, or however you want to float your boat.)
---
# and now you can create your org's application releases
apiVersion: myorg.domain/v1
kind: Application
metadata:
  name: example
spec:
  # follow the definition provided in the airway!
```

And for development purposes, users that have the permissions to modify Airways are also able to add an annotation to CRs to override the module used for that CR:
```yaml
# and now you can create your org's application releases
apiVersion: myorg.domain/v1
kind: Application
metadata:
  name: example
  annotations:
    overrides.yoke.cd/flight: oci://registry/some-other-module-or-version
spec:
  # ...
```

Given that the Air-Traffic-Controller is used to deploy arbitrary resources (like ArgoCD or Flux), it is by default given cluster-admin permissions. (Although you can deploy it with whatever service account you wish, scoping its permissions to only what it needs.)

Finally, we have all the context we need.

If a user has the RBAC required (the ability to update Airways or Flights), they can modify the module URL or add the override annotation to any custom resource, pointing the ATC at a module of their choosing.

The Air-Traffic-Controller will then download and execute whatever module that user pointed it at.

To make this concrete: a developer with permissions to update an Airway or Flight — a role you might reasonably hand out — can point the module URL at something they control. Since the ATC runs with cluster-admin, that module can produce whatever Kubernetes resources it wants: new ClusterRoles granting the attacker permissions they were never supposed to have, workloads designed to read and exfiltrate secrets, or jobs that use your cluster's compute for their own purposes. It is a privilege escalation attack. The attacker does not need cluster-admin. They just need access to someone who does.

This is a lovely find for security researchers, because they can yell Remote Code Execution from the rooftops. And they aren't technically incorrect.

Now I know that I've been relatively flippant in the tone of this blog post. Partly because I want the read to be entertaining, and partly because I think the buzzwordy RCE attack vector was in fact overblown. That does not, however, mean the issue was taken lightly, or that nothing was learned from it.

## Why the RCE is Overblown

The RCE label is wrong. This is a supply chain attack.

The fear is that Wasm is code, and code means arbitrary execution: filesystem access, network calls, a shell on your host. But Wasm is sandboxed. It cannot make syscalls to your OS. It cannot read the environment on the machine executing it. Cannot open files. Cannot make network requests. None of this is possible without the WebAssembly System Interface (WASI), and while Yoke does provide WASI P1 to the modules it executes, that is limited to things like getting the current time or generating random numbers. There is no shell. There is no network.

Well, to be honest, it does expose one custom function: the ability to look up resources in the cluster. But that is opt-in (unavailable by default), and it only allows reading resources from the context of the current release (unless explicitly granted access to more). A module cannot, on its own, read your cluster data and phone home with it. It would need to deploy a workload to do that.

And that is the point: the threat is in what gets deployed, not in what executes. A module that produces a ClusterRoleBinding granting the attacker cluster-admin is dangerous. The Wasm runtime that produced it is not.

This is not a Yoke problem. Helm charts can look up resources in your cluster and deploy them too, via tools like ArgoCD or Flux, each getting their own cluster-admin permissions. Nobody frames a compromised Helm chart as arbitrary code execution. Whether the logic is encoded in a Wasm module or hidden in YAML templates computed via Go templating and Helm, the harmful artifact is what is produced. Not how.

So the question becomes: how can we protect ourselves and our clusters when we depend on third-party package definitions?

A good practice would be to have a policy engine in your cluster like Kyverno or Kubewarden. (Big shoutout to Kubewarden, it's also a Wasm module-based project. Yoke and Kubewarden have no affiliation, but spiritually I love to think they are cousins.)

You could then write policies to have your cluster reject modules (or Helm charts) that you do not trust to run in your cluster.

And although that answer is correct, and I recommend all production-grade clusters have such a solution, it feels empty and unsatisfying.

This is because Yoke wants to feel safe and usable as a standalone project. And a policy engine cannot entirely protect against supply-chain attacks.

What if a module at the repo and tag you are using gets replaced with a malicious one, for example? Or a new version is published that is malicious? You would be hard-pressed to write a policy that can protect against seemingly benign modules.

So although the CVE may have focused a little too much on an overhyped attack vector, it did surface a good question for Yoke going forward:

How do we deal with module provenance?

## Module Provenance

The approach we went for is: explicit and implicit checksum support, digest pinning, code signing, and allow-listing. Together they cover the main ways a supply chain can be compromised: a trusted module being silently replaced, a deployed module changing underneath a running system, a new malicious version being published, and modules from untrusted sources being used at all.

Let's deal with them one by one.

### Explicit and Implicit Checksum Support

The most direct attack: a module at a URL you trust is silently swapped for a malicious one. Modules were previously only identified by their URL, whether it was a local filesystem path, an HTTP/HTTPS URL, or an OCI registry reference.

If the underlying module changed underneath your feet at that URL, then that was it. Now we can explicitly add the expected SHA-256 checksum when requesting a module, meaning that if the module being served by the URL is not what we expect, we can reject it early and never execute the module.

For convenience, module publishers can advertise the checksum as part of the registry tag or URL base path. If the checksum is not explicitly passed by the consumer, the advertised checksum is used.

For example, a module hosted at `oci://registry/module:sha256_somesha256checksum` will need to match the checksum `somesha256checksum` exactly.

This allows users to guarantee exactly what module they are referencing, and ensures it cannot silently change on them.

### Digest Pinning

Suppose you haven't explicitly pinned your module with a checksum. Of course your setup is a little less safe, but does that mean the Yoke project should offer no protection and allow you to get pwned for your negligence? No.

Yoke keeps a limited history of your releases, including the SHA of the module used for any given release revision. Suppose you are using a system like the Air-Traffic-Controller to manage your releases. If the ATC is restarted, it will re-fetch all modules. If a module URL was compromised and replaced with a malicious module, digest pinning means Yoke will notice that the current module does not match the release history and reject it.

### Code Signing

So far we have been dealing with cases where a module at a known URL is swapped out for a malicious one. The other common attack is simpler: an attacker publishes a new version that is malicious.

Yoke allows module authors to sign their modules using RSA/ED25519/ECDSA private keys. Users can configure their ATC deployment, ArgoCD plugin, or Yoke CLI to only accept modules signed by keys in a trusted keyset. This lets us establish trust in publisher identities, giving confidence in the provenance of the modules you deploy.

### Allow-Listing

Finally, for server-side components like the Air-Traffic-Controller or ArgoCD CMP, we can configure an allow-list of accepted modules (with glob support) to restrict what modules can be used at all.

Examples:
- `oci://my-registry/*` (any module in my registry)
- `oci://some-registry/mod:1.*` (any 1.x version of "mod" in "some-registry")

---

None of these is a silver bullet on its own. Used in combination, they give you real defense in depth: from the coarse (allow-listing) to the precise (checksum pinning and code signing). The CVE was a useful nudge to ask questions the project probably should have asked earlier. Hopefully this gives you enough to sleep at night. We are working on it too.
