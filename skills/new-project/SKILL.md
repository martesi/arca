---
name: new-project
description: Plan and scaffold a lean, reproducible new software project. Use when starting a new repository or application: stress-test the product and architecture first, establish a reproducible development environment, then choose the smallest suitable technology stack and scaffold it. Do not impose these defaults on an established project unless migration is explicitly requested.
version: 0.2.1
---

# New Project

Work in this order. Do not choose tools before the decisions they depend on are settled.

1. Read `references/grilling.md`, load the upstream grilling skill, and use it to settle the product and architecture decisions. Treat explicit user choices as already-settled branches.
2. Read `references/environment.md` and establish a reproducible development environment before relying on host-installed tooling.
3. Read `references/tech-stack.md` and choose only the smallest coherent stack that fits the settled requirements.
4. Scaffold the smallest useful slice, install only required dependencies, and run the narrowest checks that prove the setup works.

Keep repository conventions and explicit user requirements authoritative. Do not migrate an existing project merely to match these defaults.
