package com.ornek.test;

import java.io.File;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.List;

/**
 * Tiny JUnit-like runner: every class whose name ends with "Test" under the
 * compiled test directory is instantiated once per {@link Test} method.
 */
public final class TestRunner {
    private TestRunner() {
    }

    public static int runAll(File classesDir, ClassLoader loader) throws Exception {
        List<String> names = new ArrayList<String>();
        collect(classesDir, "", names);
        Collections.sort(names);
        int run = 0;
        int failed = 0;
        for (String name : names) {
            Class<?> c = loader.loadClass(name);
            if (Modifier.isAbstract(c.getModifiers())) continue;
            Method[] methods = c.getDeclaredMethods();
            Arrays.sort(methods, new Comparator<Method>() {
                @Override
                public int compare(Method a, Method b) {
                    return a.getName().compareTo(b.getName());
                }
            });
            for (Method m : methods) {
                if (!m.isAnnotationPresent(Test.class)) continue;
                run++;
                try {
                    Object instance = c.getDeclaredConstructor().newInstance();
                    m.setAccessible(true);
                    m.invoke(instance);
                    System.out.println("  [OK]   " + c.getSimpleName() + "." + m.getName());
                } catch (InvocationTargetException e) {
                    failed++;
                    Throwable t = e.getCause();
                    System.out.println("  [HATA] " + c.getSimpleName() + "." + m.getName() + ": " + t);
                    StackTraceElement[] st = t.getStackTrace();
                    for (int i = 0; i < Math.min(4, st.length); i++) System.out.println("      at " + st[i]);
                }
            }
        }
        System.out.println(run + " test, " + failed + " hata");
        return failed;
    }

    private static void collect(File dir, String pkg, List<String> out) {
        File[] files = dir.listFiles();
        if (files == null) return;
        for (File f : files) {
            if (f.isDirectory()) {
                collect(f, pkg.isEmpty() ? f.getName() : pkg + "." + f.getName(), out);
            } else if (f.getName().endsWith("Test.class") && !f.getName().contains("$")) {
                String simple = f.getName().substring(0, f.getName().length() - ".class".length());
                out.add(pkg.isEmpty() ? simple : pkg + "." + simple);
            }
        }
    }
}
