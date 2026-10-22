import java.io.File;
import java.io.IOException;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.attribute.BasicFileAttributes;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import javax.tools.JavaCompiler;
import javax.tools.ToolProvider;

/**
 * Offline build tool (no Maven/Gradle/JUnit needed, works on JDK 8 and newer).
 *
 *   javac -d tools tools/Build.java
 *   java -cp tools Build compile | test | run | clean
 *
 * Sources are always compiled for Java 8 (--release 8 on JDK 9+, -source/-target 1.8 on JDK 8).
 */
public class Build {
    static final Path MAIN = Paths.get("src", "main", "java");
    static final Path TEST = Paths.get("src", "test", "java");
    static final Path OUT = Paths.get(".build", "classes");
    static final Path TEST_OUT = Paths.get(".build", "test-classes");

    public static void main(String[] args) throws Exception {
        String cmd = args.length > 0 ? args[0] : "test";
        switch (cmd) {
            case "clean":
                delete(Paths.get(".build", "classes"));
                delete(Paths.get(".build", "test-classes"));
                break;
            case "compile":
                exitOnError(compile(MAIN, OUT, Collections.<Path>emptyList()));
                break;
            case "test": {
                exitOnError(compile(MAIN, OUT, Collections.<Path>emptyList()));
                exitOnError(compile(TEST, TEST_OUT, Collections.singletonList(OUT)));
                int failures = runTests();
                System.exit(failures == 0 ? 0 : 1);
                break;
            }
            case "run": {
                exitOnError(compile(MAIN, OUT, Collections.<Path>emptyList()));
                URLClassLoader cl = loader(OUT);
                Method m = cl.loadClass("com.ornek.envanter.App").getMethod("main", String[].class);
                m.invoke(null, (Object) Arrays.copyOfRange(args, 1, args.length));
                break;
            }
            default:
                System.err.println("Kullan\u0131m: java -cp tools Build compile|test|run|clean");
                System.exit(2);
        }
    }

    static void exitOnError(boolean ok) {
        if (!ok) System.exit(1);
    }

    static boolean compile(Path srcRoot, Path out, List<Path> classpath) throws IOException {
        JavaCompiler javac = ToolProvider.getSystemJavaCompiler();
        if (javac == null) {
            System.err.println("Derleyici bulunamad\u0131: JRE de\u011fil JDK kullan\u0131n (JAVA_HOME bir JDK'y\u0131 g\u00f6stermeli).");
            return false;
        }
        List<String> files = sources(srcRoot);
        if (files.isEmpty()) return true;
        Files.createDirectories(out);
        List<String> opts = new ArrayList<String>();
        if (javaMajor() >= 9) {
            opts.addAll(Arrays.asList("--release", "8"));
        } else {
            opts.addAll(Arrays.asList("-source", "1.8", "-target", "1.8"));
        }
        opts.addAll(Arrays.asList("-encoding", "UTF-8", "-Xlint:-options", "-g", "-d", out.toString()));
        if (!classpath.isEmpty()) {
            StringBuilder cp = new StringBuilder();
            for (Path p : classpath) {
                if (cp.length() > 0) cp.append(File.pathSeparator);
                cp.append(p.toString());
            }
            opts.add("-cp");
            opts.add(cp.toString());
        }
        opts.addAll(files);
        int rc = javac.run(null, null, null, opts.toArray(new String[0]));
        if (rc != 0) System.err.println("Derleme ba\u015far\u0131s\u0131z: " + srcRoot);
        return rc == 0;
    }

    static int runTests() throws Exception {
        URLClassLoader cl = loader(OUT, TEST_OUT);
        Class<?> runner = cl.loadClass("com.ornek.test.TestRunner");
        Object failures = runner.getMethod("runAll", File.class, ClassLoader.class).invoke(null, TEST_OUT.toFile(), cl);
        return (Integer) failures;
    }

    static URLClassLoader loader(Path... dirs) throws IOException {
        URL[] urls = new URL[dirs.length];
        for (int i = 0; i < dirs.length; i++) urls[i] = dirs[i].toUri().toURL();
        return new URLClassLoader(urls, Build.class.getClassLoader());
    }

    static List<String> sources(Path root) throws IOException {
        final List<String> out = new ArrayList<String>();
        if (!Files.isDirectory(root)) return out;
        Files.walkFileTree(root, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) {
                if (file.toString().endsWith(".java")) out.add(file.toString());
                return FileVisitResult.CONTINUE;
            }
        });
        Collections.sort(out);
        return out;
    }

    static int javaMajor() {
        String v = System.getProperty("java.specification.version", "1.8");
        return v.startsWith("1.") ? Integer.parseInt(v.substring(2)) : Integer.parseInt(v);
    }

    static void delete(Path p) throws IOException {
        if (!Files.exists(p)) return;
        Files.walkFileTree(p, new SimpleFileVisitor<Path>() {
            @Override
            public FileVisitResult visitFile(Path file, BasicFileAttributes attrs) throws IOException {
                Files.delete(file);
                return FileVisitResult.CONTINUE;
            }

            @Override
            public FileVisitResult postVisitDirectory(Path dir, IOException e) throws IOException {
                Files.delete(dir);
                return FileVisitResult.CONTINUE;
            }
        });
    }
}
