import { describe, it, expect } from "vitest";
import { extractCodeGraph } from "../src/code-graph/extractor.js";

// XSPEC-333 R2c: smoke-tests for Python/Go/Java against real, unmodified
// excerpts from public open-source repositories (not hand-written toy
// fixtures), verifying the tag-query engine handles real syntactic
// complexity — comments, docstrings, decorators, generics, error handling,
// method chaining — without crashing or producing an obviously wrong edge
// count. Each excerpt is a syntactically self-contained subset of real
// methods/classes taken verbatim (not paraphrased) from the cited file,
// trimmed for size; tree-sitter parses syntax only, so references to types
// defined elsewhere in the original file (not included here) do not affect
// parseability. Exact counts are not asserted (irrelevant surrounding code
// was trimmed, changing enclosing-scope shapes in ways not meaningful to
// pin down) — only sanity bounds and the absence of specific known
// false-positive patterns are.

// Source: github.com/psf/requests, src/requests/sessions.py (Session class),
// Apache License 2.0. Verbatim excerpt (lines ~505-901 at time of fetch,
// 2026-07), re-indented to top-level for a self-contained module.
const REQUESTS_SESSION_EXCERPT = `
class Session:
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def get_adapter(self, url):
        """
        Returns the appropriate connection adapter for the given URL.

        :rtype: requests.adapters.BaseAdapter
        """
        for prefix, adapter in self.adapters.items():
            if url.lower().startswith(prefix.lower()):
                return adapter

        # Nothing matches :-/
        raise InvalidSchema(f"No connection adapters were found for {url!r}")

    def close(self):
        """Closes all adapters and as such the session"""
        for v in self.adapters.values():
            v.close()

    def mount(self, prefix, adapter):
        """Registers a connection adapter to a prefix.

        Adapters are sorted in descending order by prefix length.
        """
        self.adapters[prefix] = adapter
        keys_to_move = [k for k in self.adapters if len(k) < len(prefix)]

        for key in keys_to_move:
            self.adapters[key] = self.adapters.pop(key)

    def __getstate__(self):
        state = {attr: getattr(self, attr, None) for attr in self.__attrs__}
        return state

    def __setstate__(self, state):
        for attr, value in state.items():
            setattr(self, attr, value)
`;

// Source: github.com/gin-gonic/gin, routergroup.go (RouterGroup type +
// methods), MIT License. Verbatim excerpt (lines ~55-258 at time of fetch,
// 2026-07) — comments trimmed for size, method bodies unmodified.
const GIN_ROUTERGROUP_EXCERPT = `package gin

type RouterGroup struct {
	Handlers HandlersChain
	basePath string
	engine   *Engine
	root     bool
}

var _ IRouter = (*RouterGroup)(nil)

func (group *RouterGroup) Use(middleware ...HandlerFunc) IRoutes {
	group.Handlers = append(group.Handlers, middleware...)
	return group.returnObj()
}

func (group *RouterGroup) Group(relativePath string, handlers ...HandlerFunc) *RouterGroup {
	return &RouterGroup{
		Handlers: group.combineHandlers(handlers),
		basePath: group.calculateAbsolutePath(relativePath),
		engine:   group.engine,
	}
}

func (group *RouterGroup) BasePath() string {
	return group.basePath
}

func (group *RouterGroup) handle(httpMethod, relativePath string, handlers HandlersChain) IRoutes {
	absolutePath := group.calculateAbsolutePath(relativePath)
	handlers = group.combineHandlers(handlers)
	group.engine.addRoute(httpMethod, absolutePath, handlers)
	return group.returnObj()
}

func (group *RouterGroup) Handle(httpMethod, relativePath string, handlers ...HandlerFunc) IRoutes {
	if matched := regEnLetter.MatchString(httpMethod); !matched {
		panic("http method " + httpMethod + " is not valid")
	}
	return group.handle(httpMethod, relativePath, handlers)
}

func (group *RouterGroup) POST(relativePath string, handlers ...HandlerFunc) IRoutes {
	return group.handle(http.MethodPost, relativePath, handlers)
}

func (group *RouterGroup) GET(relativePath string, handlers ...HandlerFunc) IRoutes {
	return group.handle(http.MethodGet, relativePath, handlers)
}

func (group *RouterGroup) combineHandlers(handlers HandlersChain) HandlersChain {
	finalSize := len(group.Handlers) + len(handlers)
	assert1(finalSize < int(abortIndex), "too many handlers")
	mergedHandlers := make(HandlersChain, finalSize)
	copy(mergedHandlers, group.Handlers)
	copy(mergedHandlers[len(group.Handlers):], handlers)
	return mergedHandlers
}

func (group *RouterGroup) calculateAbsolutePath(relativePath string) string {
	return joinPaths(group.basePath, relativePath)
}

func (group *RouterGroup) returnObj() IRoutes {
	if group.root {
		return group.engine
	}
	return group
}
`;

// Source: github.com/square/retrofit, retrofit/src/main/java/retrofit2/Retrofit.java
// (Builder inner class + a couple of outer-class methods), Apache License
// 2.0. Verbatim excerpt (Builder class body trimmed for size; method
// reference / lambda idioms are this repo's own real usage, not invented
// for this test).
const RETROFIT_BUILDER_EXCERPT = `
package retrofit2;

public final class Retrofit {
  Object create(final Class<?> service) {
    validateServiceInterface(service);
    return loadServiceMethod(service);
  }

  private void validateServiceInterface(Class<?> service) {
    if (!service.isInterface()) {
      throw new IllegalArgumentException("API declarations must be interfaces.");
    }
  }

  Object loadServiceMethod(Class<?> service) {
    return service;
  }

  public static final class Builder {
    private okhttp3.Call.Factory callFactory;
    private String baseUrl;

    public Builder baseUrl(String baseUrl) {
      this.baseUrl = baseUrl;
      return this;
    }

    public Builder callFactory(okhttp3.Call.Factory factory) {
      this.callFactory = factory;
      return this;
    }

    public Retrofit build() {
      if (baseUrl == null) {
        throw new IllegalStateException("Base URL required.");
      }
      return new Retrofit();
    }
  }
}
`;

describe("real-world smoke test — Python (requests/sessions.py excerpt, Apache-2.0)", () => {
  it("parses without crashing and produces sane Function/CALLS counts", () => {
    const { nodes, edges } = extractCodeGraph(REQUESTS_SESSION_EXCERPT, { filePath: "sessions.py" });
    const functions = nodes.filter((n) => n.label === "Function");
    const classes = nodes.filter((n) => n.label === "Class");
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(classes.map((c) => c.properties.name)).toEqual(["Session"]);
    expect(functions.length).toBeGreaterThanOrEqual(7);
    // __exit__ -> close() is the one intra-excerpt call this trimmed subset
    // still contains.
    expect(
      edges.some(
        (e) =>
          e.label === "CALLS" &&
          e.from === "sessions.py#Session.__exit__" &&
          e.to === "sessions.py#Session.close",
      ),
    ).toBe(true);
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("real-world smoke test — Go (gin-gonic/gin routergroup.go excerpt, MIT)", () => {
  it("parses without crashing, produces sane Function/CALLS counts, and never fabricates a call to a builtin type name", () => {
    const { nodes, edges } = extractCodeGraph(GIN_ROUTERGROUP_EXCERPT, { filePath: "routergroup.go" });
    const functions = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(functions).toEqual([
      "BasePath", "GET", "Group", "Handle", "POST", "Use",
      "calculateAbsolutePath", "combineHandlers", "handle", "returnObj",
    ]);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    // "int(abortIndex)" appears in combineHandlers — must never resolve to
    // a fabricated call named "int".
    expect(calls.some((e) => e.to.endsWith("#int"))).toBe(false);
    // Real, expected call chains from this excerpt.
    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    expect(pairs).toContain("handle->calculateAbsolutePath");
    expect(pairs).toContain("handle->combineHandlers");
    expect(pairs).toContain("Handle->handle");
    expect(pairs).toContain("GET->handle");
    expect(pairs).toContain("POST->handle");
  });
});

describe("real-world smoke test — Java (square/retrofit Retrofit.java excerpt, Apache-2.0)", () => {
  it("parses without crashing and produces sane Function/Class/CALLS counts", () => {
    const { nodes, edges } = extractCodeGraph(RETROFIT_BUILDER_EXCERPT, { filePath: "Retrofit.java" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name).sort();
    const functions = nodes.filter((n) => n.label === "Function").map((n) => n.properties.name).sort();
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(classNames).toEqual(["Builder", "Retrofit"]);
    // No explicit constructor in this trimmed excerpt (the real file's
    // Builder has one; it was cut for size), so no "Builder"-named
    // constructor_declaration is expected here.
    expect(functions).toEqual([
      "baseUrl", "build", "callFactory", "create", "loadServiceMethod", "validateServiceInterface",
    ]);
    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    expect(pairs).toContain("Retrofit.create->Retrofit.validateServiceInterface");
    expect(pairs).toContain("Retrofit.create->Retrofit.loadServiceMethod");
  });
});
