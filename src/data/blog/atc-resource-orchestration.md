---
author: David Desmarais-Michaud
pubDatetime: 2025-10-01
title: Resource Orchestration with the Yoke ATC
slug: yoke-resource-orchestration
featured: true
description: >
  If your application is more than just a simple list of manifests, 
  you've probably felt the pain of orchestration in Kubernetes. 
  We dive into a new model that replaces static YAML with simple, executable code,
  letting you build complex, reactive deployments without having to write a full-blown operator.
tags:
  - Yoke
  - AirTrafficController
---

## Table of Contents

## A Brief Primer

This post reads better if you understand the basics of [yoke](/docs) and the [Air Traffic Controller](/docs/airtrafficcontroller/atc).

In essence, Yoke provides a way to define packages as shareable programs compiled to [WASM](https://webassembly.org/) called Flights.
The Air Traffic Controller allows you to extend the Kubernetes API via Airways, a custom resource that defines a CRD for your cluster and binds it to a flight. 

This blog post is about how the Air Traffic Controller can enable powerful, arbitrary resource orchestration.

Enjoy.

## Beyond Flat YAML: True Orchestration in Kubernetes

If you've ever managed a complex application in Kubernetes, you've likely felt the anxiety of waiting for all your resources to become healthy. You have a database that needs to be ready before your application starts, a series of batch jobs that must run in perfect sequence, or a service that depends on a secret managed by a completely different system. How do you express these relationships? Today, in general, you don't.

For years, the tools we've reached for, like Helm and Kustomize, haven't really had an answer. They’ve taught us to see our packages as a flat list of YAML manifests, a static collection of resources to be thrown over the wall at the Kubernetes API. This is great for simple, stateless apps, but the moment you want to express order, coordination, or statefulness, things get complicated.

Here, we're talking about orchestration: the ability to intelligently manage the lifecycle of an application's components, not just create them and hope for the best.

### The Orchestration Gap

The reason for this gap is historical. Tools like Helm and Kustomize are client-side templating engines. They generate manifests, and their job ends there. Even server-side GitOps tools like ArgoCD or FluxCD inherit this worldview, as they primarily use those tools under the hood to generate the manifests they will sync on your behalf.

Sure, there are workarounds. You might have used Helm’s pre/post-install hooks or ArgoCD's sync waves. While useful, these solutions are often shallow. They apply at installation or update time but don't persist throughout the application's life.

## A Word on YAML and Eventual Consistency

Now, we know that suggesting a move away from pure YAML can be controversial. For many in the community, raw manifests are the one true way to interface with the Kubernetes API. This attachment has led us to lean heavily on one core pattern to solve complex dependency problems: eventual consistency.

The idea is to deploy everything at once and simply trust that, eventually, controllers will reconcile, dependencies will become available, and things will just… work. We've all seen this in practice: a pod enters CrashLoopBackOff until its required ConfigMap or Secret is finally created by another system.

To be clear, eventual consistency is a fundamental part of how Kubernetes works, and it's a powerful concept. The problem is that, for too long, it has been our only tool for managing complex workflows. We were forced to rely on it because our tools gave us no other choice; the medium is the message. Our YAML-centric tools could only express a desired end state, not the journey to get there.

## The Operator Dilemma

Traditionally, if you needed truly intelligent, reactive deployment strategies, the answer was always the same: "Build an operator."

While building an operator is a powerful and valid approach, it's a significant undertaking. It comes with a steep learning curve and ongoing development and maintenance costs that not every team can justify. Isn't there a middle ground?

## A New Model: Application Logic as Code

This is where [yoke](https://github.com/yokecd/yoke) and the AirTrafficController (ATC), introduce a different way of thinking. Instead of generating a static set of YAML manifest files, [yoke](https://github.com/yokecd/yoke) defines its packages as executable code.

This allows you to focus purely on your application's orchestration logic by writing a simple program that follows a familiar pattern:

1. Read the inputs from your custom resource.
2. Make decisions based on the live state from the cluster.
3. Update your custom resource's status with progress or information.
4. Emit the desired resources that should exist in the cluster right now.

If that reminds you of the textbook definition of a Kubernetes controller's reconciliation loop, it should.

The ATC is a controller who's sole job is to sync your instances desired package state in cluster. Your WASM module is the core logic, the proxy for the reconciliation loop, that drives the desired state (resources) of your packages, without having to build and maintain your own operator from the ground up.

## How It Works in Practice

At its heart, a [yoke](https://github.com/yokecd/yoke) "Flight" (a program compiled to WASM analagous to helm Chart) is just a program that reads a custom resource from stdin and writes the desired state of the world to stdout.

But because the ATC runs this program in a control loop, it becomes dynamic and reactive. Your code is re-executed whenever:

- A resource it manages (like a Job or Deployment) is updated or deleted.
- An external resource it's watching (like a Secret from another tool) is created, updated, or deleted.

This allows your code to react to changes in the cluster in real-time.

---
## Examples

### Example 1: A Sequential Job Pipeline

Imagine you need to create a Pipeline resource that runs three jobs in sequence: job-one, job-two, and job-three. The next job should only start after the previous one has successfully completed.

With [yoke](https://github.com/yokecd/yoke), we can codify this logic directly.

First, we'd define a Go type for our Pipeline custom resource.

```go
type Pipeline struct {
  metav1.TypeMeta
  metav1.ObjectMeta `json:"metadata"`
  Spec              struct {
    // ... Define your spec! ...
  } `json:"spec,omitzero"`
  Status struct {
    // Your status fields.
    // We will use a simple msg for our example but it can be whatever you wish it to be.
    Msg string `json:"msg"`
  }
}
```

And a corresponding Airway definition that tells the ATC how to manage it.

```go
v1alpha1.Airway{
  TypeMeta: metav1.TypeMeta{
    APIVersion: v1alpha1.AirwayGVR().GroupVersion().Identifier(),
    Kind:       v1alpha1.KindAirway,
  },
  ObjectMeta: metav1.ObjectMeta{
    Name: "pipelines.examples.com",
  },
  Spec: v1alpha1.AirwaySpec{
    WasmURLs: v1alpha1.WasmURLs{
      // The URL where your wasm module will be hosted.
      Flight: "oci://registry/repo:tag",
    },
    // In order to be able to fetch state we enable cluster access.
    ClusterAccess: true,
    // The Airway needs to by dynamic in order to be re-evaluated when sub-resources are updated/created.
    Mode: v1alpha1.AirwayModeDynamic,
    Template: apiextensionsv1.CustomResourceDefinitionSpec{
      Group: "examples.com",
      Names: apiextensionsv1.CustomResourceDefinitionNames{
        Plural:   "pipelines",
        Singular: "pipeline",
        Kind:     "Pipeline",
      },
      Scope: apiextensionsv1.NamespaceScoped,
      Versions: []apiextensionsv1.CustomResourceDefinitionVersion{
        {
          Name:    "v1",
          Served:  true,
          Storage: true,
          Schema: &apiextensionsv1.CustomResourceValidation{
            // Build the openapi definition from our CustomResource type.
            OpenAPIV3Schema: openapi.SchemaFrom(reflect.TypeFor[Pipeline]()),
          },
        },
      },
    },
  },
}
```

The real magic is in the WASM module's logic. Let's walk through it.

```go
// run contains the core orchestration logic for our Pipeline.
func run() error {
    var pipeline Pipeline
    if err := yaml.NewYAMLToJSONDecoder(os.Stdin).Decode(&pipeline); err != nil {
        return fmt.Errorf("failed to decode stdin into pipeline: %w", err)
    }

    // The 'resources' slice will contain the desired state of our application.
    // We include the pipeline itself so we can update its status.
    resources := flight.Resources{&pipeline}

    for _, job := range []*batchv1.Job{
        {
            TypeMeta:   metav1.TypeMeta{APIVersion: batchv1.SchemeGroupVersion.Identifier(), Kind: "Job"},
            ObjectMeta: metav1.ObjectMeta{Name: pipeline.Name + "-one"},
            Spec:       batchv1.JobSpec{ /* ... your job spec here ... */ },
        },
        {
            TypeMeta:   metav1.TypeMeta{APIVersion: batchv1.SchemeGroupVersion.Identifier(), Kind: "Job"},
            ObjectMeta: metav1.ObjectMeta{Name: pipeline.Name + "-two"},
            Spec:       batchv1.JobSpec{ /* ... your job spec here ... */ },
        },
        {
            TypeMeta:   metav1.TypeMeta{APIVersion: batchv1.SchemeGroupVersion.Identifier(), Kind: "Job"},
            ObjectMeta: metav1.ObjectMeta{Name: pipeline.Name + "-three"},
            Spec:       batchv1.JobSpec{ /* ... your job spec here ... */ },
        },
    } {
        // Add the current job to the desired package state.
        resources = append(resources, job)

        // Check if the current job has completed by looking it up in the cluster.
        // If not, we write the current state to stdout and exit. The ATC will
        // re-evaluate when the Job's status changes.
        ok, err := hasJobCompleted(&pipeline, job)
        if err != nil {
            return fmt.Errorf("failed to check job completion for %s: %w", job.Name, err)
        }
        if !ok {
            // Job is not done or has failed; the status is already set in hasJobCompleted.
            // We exit here and wait for the next reconciliation.
            return json.NewEncoder(os.Stdout).Encode(resources)
        }
    }

    // If we get through the whole loop, all jobs are done.
    pipeline.Status.Msg = "all jobs have completed"
    return json.NewEncoder(os.Stdout).Encode(resources)
}

// isJobStatus is a helper to check for a specific condition type in a Job's status.
func isJobStatus(job *batchv1.Job, typ batchv1.JobConditionType) bool {
    return job != nil && slices.ContainsFunc(job.Status.Conditions, func(condition batchv1.JobCondition) bool {
        return condition.Type == typ
    })
}

// hasJobCompleted checks the live state of a job in the cluster.
func hasJobCompleted(pipeline *Pipeline, job *batchv1.Job) (ok bool, err error) {
    // k8s.LookupResource fetches the current state of the resource from the Kubernetes API.
    live, err := k8s.LookupResource(job)
    if err != nil && !k8s.IsErrNotFound(err) {
        return false, fmt.Errorf("failed to lookup job %s: %w", job.Name, err)
    }

    // Check for failure first.
    if isJobStatus(live, batchv1.JobFailed) {
        pipeline.Status.Msg = fmt.Sprintf("job %s failed", job.Name)
        return false, nil // 'ok' is false, indicating we should stop.
    }

    // Check for completion.
    if !isJobStatus(live, batchv1.JobComplete) {
        pipeline.Status.Msg = fmt.Sprintf("waiting for job %s to complete", job.Name)
        return false, nil // 'ok' is false, not complete yet.
    }

    // Job is complete!
    return true, nil
}
```

This simple Go program expresses our desired orchestration. It creates one job, checks its status, and only proceeds once that job is complete. The control loop provided by the ATC handles all the "waiting" and "re-triggering" for us.

### Example 2: Coordinating with External Resources

Here's another common scenario: your application needs a database. You use Crossplane to provision a CloudSQLInstance, which eventually creates a Secret containing the connection details. Your Deployment cannot start until that Secret exists.

Today, you might deploy everything at once and let your application pod CrashLoopBackOff until the secret appears. We can do better.

Let's model an App resource that orchestrates this.

```go
type App struct {
  metav1.TypeMeta
  metav1.ObjectMeta `json:"metadata"`
  Spec              struct {
    // Your props
  } `json:"spec"`
  Status struct {
    // For the example we will use a simple message for our App status.
    // But it can be anything you want!
    Msg string `json:"msg"`
  } `json:"status,omitzero"`
}
```

The Airway definition would be configured to allow cluster access, specifically to look up Secret resources.

```go
v1alpha1.Airway{
  TypeMeta: metav1.TypeMeta{
    APIVersion: v1alpha1.AirwayGVR().GroupVersion().Identifier(),
    Kind:       v1alpha1.KindAirway,
  },
  ObjectMeta: metav1.ObjectMeta{
    Name: "pipelines.examples.com",
  },
  Spec: v1alpha1.AirwaySpec{
    WasmURLs: v1alpha1.WasmURLs{
      // The URL where your wasm module will be hosted.
      Flight: "oci://registry/repo:tag",
    },
    // In order to be able to fetch state we enable cluster access.
    ClusterAccess: true,
    // We explicitly grant permission to look up Secrets.
    // Any lookup of a non-owned resource not listed here will be denied.
    ResourceAccessMatchers: []string{"Secret"},
    // The Airway needs to by dynamic in order to be re-evaluated when sub-resources are updated/created.
    Mode: v1alpha1.AirwayModeDynamic,
    Template: apiextensionsv1.CustomResourceDefinitionSpec{
      Group: "examples.com",
      Names: apiextensionsv1.CustomResourceDefinitionNames{
        Plural:   "apps",
        Singular: "app",
        Kind:     "App",
      },
      Scope: apiextensionsv1.NamespaceScoped,
      Versions: []apiextensionsv1.CustomResourceDefinitionVersion{
        {
          Name:    "v1",
          Served:  true,
          Storage: true,
          Schema: &apiextensionsv1.CustomResourceValidation{
            // Build the openapi definition from our CustomResource type.
            OpenAPIV3Schema: openapi.SchemaFrom(reflect.TypeFor[App]()),
          },
        },
      },
    },
  },
}
```

The logic in our WASM module would look like this:

```go
// run contains the core orchestration logic for our App.
func run() error {
    var app App
    if err := yaml.NewYAMLToJSONDecoder(os.Stdin).Decode(&app); err != nil {
        return fmt.Errorf("failed to decode stdin into App instance: %v", err)
    }

    // Include the app itself in the final result to set its status.
    resources := flight.Resources{&app}

    // 1. Define the database instance using the Crossplane provider.
    database := databasev1beta1.CloudSQLInstance{
        TypeMeta: metav1.TypeMeta{
            APIVersion: databasev1beta1.SchemeGroupVersion.Identifier(),
            Kind:       "CloudSQLInstance",
        },
        ObjectMeta: metav1.ObjectMeta{Name: app.Name},
        Spec: databasev1beta1.CloudSQLInstanceSpec{
            ForProvider: databasev1beta1.CloudSQLInstanceParameters{ /* ... your params ... */ },
            ResourceSpec: commonv1.ResourceSpec{
                WriteConnectionSecretToReference: &commonv1.SecretReference{
                    Name:      app.Name,
                    Namespace: app.Namespace,
                },
            },
        },
    }
    resources = append(resources, &database)

    // 2. Try to look up the secret that Crossplane will create.
    secretIdentifier := k8s.ResourceIdentifier{
        Name:       database.Spec.WriteConnectionSecretToReference.Name,
        Namespace:  database.Spec.WriteConnectionSecretToReference.Namespace,
        ApiVersion: "v1",
        Kind:       "Secret",
    }

    secret, err := k8s.Lookup[corev1.Secret](secretIdentifier)
    if err != nil {
        if k8s.IsErrNotFound(err) {
            // The secret doesn't exist yet. We'll update the status and wait.
            // The ATC will automatically re-run our code when the secret is created.
            app.Status.Msg = "Waiting for connection secret to be created"
            return json.NewEncoder(os.Stdout).Encode(resources)
        }
        return fmt.Errorf("failed to fetch connection secret: %w", err)
    }

    // 3. The secret exists! We can now create the deployment that uses it.
    deployment := &appsv1.Deployment{
        TypeMeta: metav1.TypeMeta{
            APIVersion: appsv1.SchemeGroupVersion.Identifier(),
            Kind:       "Deployment",
        },
        ObjectMeta: metav1.ObjectMeta{Name: app.Name},
        Spec: appsv1.DeploymentSpec{
            Template: corev1.PodTemplateSpec{
                Spec: corev1.PodSpec{
                    Containers: []corev1.Container{
                        {
                            // ... other container fields ...
                            EnvFrom: []corev1.EnvFromSource{
                                {
                                    SecretRef: &corev1.SecretEnvSource{
                                        LocalObjectReference: corev1.LocalObjectReference{Name: secret.Name},
                                    },
                                },
                            },
                        },
                    },
                },
            },
        },
    }
    resources = append(resources, deployment)

    // 4. As a final step, report on the status of our own deployment.
    live, err := k8s.LookupResource(deployment)
    if err != nil && !k8s.IsErrNotFound(err) {
        return fmt.Errorf("failed to lookup deployment: %w", err)
    }

    if live != nil && slices.ContainsFunc(live.Status.Conditions, func(cond appsv1.DeploymentCondition) bool {
        return cond.Type == appsv1.DeploymentAvailable && cond.Status == corev1.ConditionTrue
    }) {
        app.Status.Msg = "application deployed and ready"
    } else {
        app.Status.Msg = "waiting for application to become ready"
    }

    return json.NewEncoder(os.Stdout).Encode(resources)
}
```

This logic expresses the dependency: create the database, wait for its secret, and only then create the application deployment. No more crash-looping pods, just clean, stateful orchestration.

--- 

## Closing Thoughts

By embracing application logic as code, [yoke](https://github.com/yokecd/yoke) provides a powerful middle ground between static YAML templates and full-blown operators. It empowers you to codify complex, stateful, and reactive deployment strategies using the programming languages and tools you already know, bringing true orchestration within reach for everyone.

---

## Resources

- [docs](https://yokecd.github.io/docs)
- [air-traffic-controller](https://yokecd.github.io/docs/airtrafficcontroller/atc)
