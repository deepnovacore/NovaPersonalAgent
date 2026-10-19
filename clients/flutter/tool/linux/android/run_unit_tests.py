#!/usr/bin/env python3
"""Compile the Android-independent process supervisor and run its JUnit tests."""
import argparse
import os
from pathlib import Path
import subprocess

p = argparse.ArgumentParser()
p.add_argument('--output', type=Path, required=True)
p.add_argument('--java-home', type=Path, required=True)
p.add_argument('--gradle-cache', type=Path, required=True)
a = p.parse_args()
# The supervisor rejects noncanonical log paths, including harmless output /../ segments.
a.output = a.output.resolve()
a.output.mkdir(parents=True, exist_ok=True)
repo = Path(__file__).resolve().parents[5]
cache = a.gradle_cache / 'caches/modules-2/files-2.1'
def jar(group, name, version):
    return str(next((cache / group / name / version).glob('*/*.jar')))
stdlib = jar('org.jetbrains.kotlin', 'kotlin-stdlib', '2.3.20')
junit = jar('junit', 'junit', '4.13.2')
hamcrest = jar('org.hamcrest', 'hamcrest-core', '1.3')
annotations = jar('org.jetbrains', 'annotations', '13.0')
compiler = jar('org.jetbrains.kotlin', 'kotlin-compiler-embeddable', '2.3.20')
compiler_deps = [compiler, stdlib, annotations]
for name in ['kotlin-script-runtime', 'kotlin-reflect']:
    compiler_deps.append(str(sorted((cache / 'org.jetbrains.kotlin' / name).glob('*/*/*.jar'))[-1]))
compiler_deps.append(str(sorted((cache / 'org.jetbrains.kotlinx' / 'kotlinx-coroutines-core-jvm').glob('*/*/*.jar'))[-1]))
classpath = os.pathsep.join([stdlib, junit, hamcrest, annotations])
source = repo / 'clients/flutter/android/app/src'
java = str(a.java_home / 'bin/java')
subprocess.run([java, '-cp', os.pathsep.join(compiler_deps), 'org.jetbrains.kotlin.cli.jvm.K2JVMCompiler', '-no-stdlib', '-no-reflect', '-jvm-target', '17', '-classpath', classpath, '-d', str(a.output), str(source / 'main/kotlin/com/nova/nova_mobile/LinuxExecution.kt'), str(source / 'test/kotlin/com/nova/nova_mobile/LinuxExecutionTest.kt')], check=True)
subprocess.run([java, '-Djava.io.tmpdir=' + str(a.output), '-cp', os.pathsep.join([str(a.output), classpath]), 'org.junit.runner.JUnitCore', 'com.nova.nova_mobile.LinuxExecutionTest'], check=True)
