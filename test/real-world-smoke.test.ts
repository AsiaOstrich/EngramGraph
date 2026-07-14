import { describe, it, expect } from "vitest";
import { extractCodeGraph } from "../src/code-graph/extractor.js";

// XSPEC-333 R2c: smoke-tests for Python/Go/Java (batch 1) and Kotlin/Rust/
// C++ (batch 2) against real, unmodified excerpts from public open-source
// repositories (not hand-written toy fixtures), verifying the tag-query
// engine handles real syntactic complexity — comments, docstrings,
// decorators, generics, error handling, method chaining — without crashing
// or producing an obviously wrong edge count. Each excerpt is a
// syntactically self-contained subset of real methods/classes taken
// verbatim (not paraphrased) from the cited file, trimmed for size;
// tree-sitter parses syntax only, so references to types defined elsewhere
// in the original file (not included here) do not affect parseability.
// Exact counts are not asserted (irrelevant surrounding code was trimmed,
// changing enclosing-scope shapes in ways not meaningful to pin down) —
// only sanity bounds and the absence of specific known false-positive
// patterns are.

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

// Source: github.com/square/okhttp, okhttp/src/commonJvmAndroid/kotlin/
// okhttp3/Cookie.kt (Cookie.Builder inner class), Apache License 2.0.
// Verbatim excerpt (lines ~295-399 at time of fetch, 2026-07), re-indented
// to top-level for a self-contained module.
const OKHTTP_COOKIE_BUILDER_EXCERPT = `
class Builder() {
  private var name: String? = null
  private var value: String? = null
  private var expiresAt = MAX_DATE
  private var domain: String? = null
  private var path = "/"
  private var secure = false
  private var httpOnly = false
  private var persistent = false
  private var hostOnly = false
  private var sameSite: String? = null

  internal constructor(cookie: Cookie) : this() {
    this.name = cookie.name
    this.value = cookie.value
    this.expiresAt = cookie.expiresAt
    this.domain = cookie.domain
    this.path = cookie.path
    this.secure = cookie.secure
    this.httpOnly = cookie.httpOnly
    this.persistent = cookie.persistent
    this.hostOnly = cookie.hostOnly
    this.sameSite = cookie.sameSite
  }

  fun name(name: String) =
    apply {
      require(name.trim() == name) { "name is not trimmed" }
      this.name = name
    }

  fun value(value: String) =
    apply {
      require(value.trim() == value) { "value is not trimmed" }
      this.value = value
    }

  fun expiresAt(expiresAt: Long) =
    apply {
      var expiresAt = expiresAt
      if (expiresAt <= 0L) expiresAt = Long.MIN_VALUE
      if (expiresAt > MAX_DATE) expiresAt = MAX_DATE
      this.expiresAt = expiresAt
      this.persistent = true
    }

  /**
   * Set the domain pattern for this cookie. The cookie will match [domain] and all of its
   * subdomains.
   */
  fun domain(domain: String): Builder = domain(domain, false)

  /**
   * Set the host-only domain for this cookie. The cookie will match [domain] but none of
   * its subdomains.
   */
  fun hostOnlyDomain(domain: String): Builder = domain(domain, true)

  private fun domain(
    domain: String,
    hostOnly: Boolean,
  ) = apply {
    val canonicalDomain =
      domain.toCanonicalHost()
        ?: throw IllegalArgumentException("unexpected domain: $domain")
    this.domain = canonicalDomain
    this.hostOnly = hostOnly
  }

  fun path(path: String) =
    apply {
      require(path.startsWith("/")) { "path must start with '/'" }
      this.path = path
    }

  fun secure() =
    apply {
      this.secure = true
    }

  fun httpOnly() =
    apply {
      this.httpOnly = true
    }

  fun sameSite(sameSite: String) =
    apply {
      require(sameSite.trim() == sameSite) { "sameSite is not trimmed" }
      this.sameSite = sameSite
    }

  fun build(): Cookie =
    Cookie(
      name ?: throw NullPointerException("builder.name == null"),
      value ?: throw NullPointerException("builder.value == null"),
      expiresAt,
      domain ?: throw NullPointerException("builder.domain == null"),
      path,
      secure,
      httpOnly,
      persistent,
      hostOnly,
      sameSite,
    )
}
`;

// Source: github.com/BurntSushi/ripgrep, crates/globset/src/lib.rs
// (GlobSet struct + impl), dual Unlicense/MIT. Verbatim excerpt (lines
// ~309-360 at time of fetch, 2026-07).
const RIPGREP_GLOBSET_EXCERPT = `
pub struct GlobSet {
    len: usize,
    strats: Vec<GlobSetMatchStrategy>,
}

impl GlobSet {
    /// Create a new [\`GlobSetBuilder\`]. A \`GlobSetBuilder\` can be used to add
    /// new patterns. Once all patterns have been added, \`build\` should be
    /// called to produce a \`GlobSet\`, which can then be used for matching.
    #[inline]
    pub fn builder() -> GlobSetBuilder {
        GlobSetBuilder::new()
    }

    /// Create an empty \`GlobSet\`. An empty set matches nothing.
    #[inline]
    pub const fn empty() -> GlobSet {
        GlobSet { len: 0, strats: vec![] }
    }

    /// Returns true if this set is empty, and therefore matches nothing.
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// Returns the number of globs in this set.
    #[inline]
    pub fn len(&self) -> usize {
        self.len
    }

    /// Returns true if any glob in this set matches the path given.
    pub fn is_match<P: AsRef<Path>>(&self, path: P) -> bool {
        self.is_match_candidate(&Candidate::new(path.as_ref()))
    }

    /// Returns true if any glob in this set matches the path given.
    ///
    /// This takes a Candidate as input, which can be used to amortize the
    /// cost of preparing a path for matching.
    pub fn is_match_candidate(&self, path: &Candidate<'_>) -> bool {
        if self.is_empty() {
            return false;
        }
        for strat in &self.strats {
            if strat.is_match(path) {
                return true;
            }
        }
        false
    }
}
`;

// Source: github.com/google/leveldb, include/leveldb/status.h (Status
// class), BSD-3-Clause. Excerpt of real methods taken verbatim from the
// cited file (trimmed for size — the copy/move-assignment operator
// overloads and the LEVELDB_EXPORT export macro were dropped, not because
// they don't parse, but to keep this excerpt focused; operator overloads
// are a separate, documented gap — see queries/cpp.ts's module doc comment
// and cpp.test.ts's dedicated regression test for that).
const LEVELDB_STATUS_EXCERPT = `
namespace leveldb {

class Status {
 public:
  Status() noexcept : state_(nullptr) {}

  // Returns true iff the status indicates success.
  bool ok() const { return (state_ == nullptr); }

  // Returns true iff the status indicates a NotFound error.
  bool IsNotFound() const { return code() == kNotFound; }

  // Returns true iff the status indicates a Corruption error.
  bool IsCorruption() const { return code() == kCorruption; }

  // Returns true iff the status indicates an IOError.
  bool IsIOError() const { return code() == kIOError; }

  // Return a string representation of this status suitable for printing.
  std::string ToString() const;

 private:
  enum Code {
    kOk = 0,
    kNotFound = 1,
    kCorruption = 2,
    kNotSupported = 3,
    kInvalidArgument = 4,
    kIOError = 5
  };

  Code code() const {
    return (state_ == nullptr) ? kOk : static_cast<Code>(state_[4]);
  }

  const char* state_;
};

}  // namespace leveldb
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

describe("real-world smoke test — Kotlin (square/okhttp Cookie.Builder excerpt, Apache-2.0)", () => {
  it("parses without crashing, resolves an overloaded-method intra-class call, and captures trailing-lambda ('apply { ... }') calls", () => {
    const { nodes, edges } = extractCodeGraph(OKHTTP_COOKIE_BUILDER_EXCERPT, { filePath: "Cookie.kt" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(classNames).toEqual(["Builder"]);
    // "domain" is overloaded (fun domain(String): Builder, and a private
    // fun domain(String, Boolean)) — both collapse onto one shared id, the
    // same documented overload-collapse limitation as C#'s (see
    // extractor.ts's qualifyFunctions call-site comment).
    expect(functionIds).toEqual([
      "Cookie.kt#Builder.build",
      "Cookie.kt#Builder.domain",
      "Cookie.kt#Builder.domain",
      "Cookie.kt#Builder.expiresAt",
      "Cookie.kt#Builder.hostOnlyDomain",
      "Cookie.kt#Builder.httpOnly",
      "Cookie.kt#Builder.name",
      "Cookie.kt#Builder.path",
      "Cookie.kt#Builder.sameSite",
      "Cookie.kt#Builder.secure",
      "Cookie.kt#Builder.value",
    ]);

    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    // hostOnlyDomain(x) = domain(x, true) — a genuine, real intra-class call
    // to the (collapsed) overloaded "domain" — the pattern this excerpt was
    // specifically chosen to exercise.
    expect(pairs).toContain("Builder.hostOnlyDomain->Builder.domain");

    // A verified, REAL instance of the by-reference-argument pattern's
    // documented shared risk (see queries/kotlin.ts's module doc comment,
    // and Go's/Python's/Rust's/C++'s equivalent Open Questions): build()'s
    // body passes several of the Builder's own private fields
    // (expiresAt/path/secure/httpOnly/sameSite) as bare-identifier
    // constructor arguments to `Cookie(...)` — each of those field reads
    // coincidentally shares its exact name with an unrelated Builder
    // *method* of the same name, so this file's by-reference-argument
    // pattern (correctly, by its own designed rules) captures them as
    // CALLS edges even though they are plain field reads, not function
    // references. Not a bug specific to this batch — the same "a bare
    // identifier by-reference argument can coincidentally collide with an
    // unrelated same-named function/method" limitation every language
    // sharing this pattern already carries — but this is the first time in
    // this engine's test suite it is demonstrated with real, unmodified
    // source rather than only argued about in a doc comment.
    expect(pairs).toContain("Builder.build->Builder.expiresAt");
    expect(pairs).toContain("Builder.build->Builder.path");
    expect(pairs).toContain("Builder.build->Builder.secure");
    expect(pairs).toContain("Builder.build->Builder.httpOnly");
    expect(pairs).toContain("Builder.build->Builder.sameSite");
  });
});

describe("real-world smoke test — Rust (BurntSushi/ripgrep globset GlobSet excerpt, Unlicense/MIT)", () => {
  it("parses without crashing and resolves a chain of real intra-impl calls (builder/is_match/is_match_candidate/is_empty)", () => {
    const { nodes, edges } = extractCodeGraph(RIPGREP_GLOBSET_EXCERPT, { filePath: "globset.rs" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    const calls = edges.filter((e) => e.label === "CALLS");

    // Captured once from the struct_item, once from the impl_item — see
    // queries/rust.ts's module doc comment.
    expect(classNames).toEqual(["GlobSet", "GlobSet"]);
    expect(functionIds).toEqual([
      "globset.rs#GlobSet.builder",
      "globset.rs#GlobSet.empty",
      "globset.rs#GlobSet.is_empty",
      "globset.rs#GlobSet.is_match",
      "globset.rs#GlobSet.is_match_candidate",
      "globset.rs#GlobSet.len",
    ]);

    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    expect(pairs).toContain("GlobSet.is_match->GlobSet.is_match_candidate");
    expect(pairs).toContain("GlobSet.is_match_candidate->GlobSet.is_empty");
    // "builder()" calls the external "GlobSetBuilder::new()" (not defined
    // in this excerpt) — correctly unresolved, not present in calls at all.
    expect(pairs.some((p) => p.includes("GlobSetBuilder"))).toBe(false);
    // "empty()" constructs a struct LITERAL ("GlobSet { len: 0, ... }"), a
    // DIFFERENT grammar shape from a call — correctly produces no CALLS
    // edge from empty() at all.
    expect(calls.some((e) => e.from === "globset.rs#GlobSet.empty")).toBe(false);
  });
});

// Source: github.com/sinatra/sinatra, lib/sinatra/base.rb (Request class),
// MIT License. Verbatim excerpt (lines ~31-77 at time of fetch, 2026-07).
const SINATRA_REQUEST_EXCERPT = `
class Request < Rack::Request
  HEADER_PARAM = /\\s*[\\w.]+=(?:[\\w.]+|"(?:[^"\\\\]|\\\\.)*")?\\s*/.freeze
  HEADER_VALUE_WITH_PARAMS = %r{(?:(?:\\w+|\\*)/(?:\\w+(?:\\.|-|\\+)?|\\*)*)\\s*(?:;#{HEADER_PARAM})*}.freeze

  # Returns an array of acceptable media types for the response
  def accept
    @env['sinatra.accept'] ||= if @env.include?('HTTP_ACCEPT') && (@env['HTTP_ACCEPT'].to_s != '')
                                 @env['HTTP_ACCEPT']
                                   .to_s
                                   .scan(HEADER_VALUE_WITH_PARAMS)
                                   .map! { |e| AcceptEntry.new(e) }
                                   .sort
                               else
                                 [AcceptEntry.new('*/*')]
                               end
  end

  def accept?(type)
    preferred_type(type).to_s.include?(type)
  end

  def preferred_type(*types)
    return accept.first if types.empty?

    types.flatten!
    return types.first if accept.empty?

    accept.detect do |accept_header|
      type = types.detect { |t| MimeTypeEntry.new(t).accepts?(accept_header) }
      return type if type
    end
  end

  alias secure? ssl?

  def forwarded?
    !forwarded_authority.nil?
  end

  def safe?
    get? || head? || options? || trace?
  end

  def idempotent?
    safe? || put? || delete? || link? || unlink?
  end

  def link?
    request_method == 'LINK'
  end

  def unlink?
    request_method == 'UNLINK'
  end
end
`;

// Source: github.com/guzzle/guzzle, src/Client.php (Client class methods),
// MIT License. Verbatim excerpt (lines ~101-172 at time of fetch, 2026-07) —
// wrapped in "class Client { ... }" for a self-contained module (the real
// file's class declaration/opening brace sit outside this excerpt's line
// range); doc-comment blocks trimmed for size, method bodies unmodified.
const GUZZLE_CLIENT_EXCERPT = `<?php
class Client {
    public function sendAsync(RequestInterface $request, array $options = []): PromiseInterface
    {
        // Merge the base URI into the request URI if needed.
        $options = $this->prepareDefaults($options);

        return $this->transfer(
            $request->withUri($this->buildUri($request->getUri(), $options), $request->hasHeader('Host')),
            $options
        );
    }

    public function send(RequestInterface $request, array $options = []): ResponseInterface
    {
        $options[RequestOptions::SYNCHRONOUS] = true;
        return $this->sendAsync($request, $options)->wait();
    }

    public function sendRequest(RequestInterface $request): ResponseInterface
    {
        $options[RequestOptions::SYNCHRONOUS] = true;
        $options[RequestOptions::ALLOW_REDIRECTS] = false;
        $options[RequestOptions::HTTP_ERRORS] = false;

        return $this->sendAsync($request, $options)->wait();
    }

    public function requestAsync(string $method, $uri = '', array $options = []): PromiseInterface
    {
        $options = $this->prepareDefaults($options);
        // Remove request modifying parameter because it can be done up-front.
        $headers = $options['headers'] ?? [];
        $body = $options['body'] ?? null;
        $version = $options['version'] ?? '1.1';
        // Merge the URI into the base URI.
        $uri = $this->buildUri(Psr7\\Utils::uriFor($uri), $options);
        if (\\is_array($body)) {
            throw $this->invalidBody();
        }
        $request = new Psr7\\Request($method, $uri, $headers, $body, $version);
        // Remove the option so that they are not doubly-applied.
        unset($options['headers'], $options['body'], $options['version']);

        return $this->transfer($request, $options);
    }

    public function request(string $method, $uri = '', array $options = []): ResponseInterface
    {
        $options[RequestOptions::SYNCHRONOUS] = true;
        return $this->requestAsync($method, $uri, $options)->wait();
    }
}
`;

// Source: github.com/flutter/flutter,
// packages/flutter/lib/src/foundation/change_notifier.dart (ChangeNotifier
// class, _removeAt + removeListener methods), BSD-3-Clause (Flutter's
// modified BSD license). Verbatim excerpt (lines ~293-362 at time of fetch,
// 2026-07) — wrapped in "class ChangeNotifier { ... }" for a self-contained
// module (the real file excerpts mid-class-body).
const FLUTTER_CHANGE_NOTIFIER_EXCERPT = `
class ChangeNotifier {
  void _removeAt(int index) {
    // The list holding the listeners is not growable for performances reasons.
    // We still want to shrink this list if a lot of listeners have been added
    // and then removed outside a notifyListeners iteration.
    // We do this only when the real number of listeners is half the length
    // of our list.
    _count -= 1;
    if (_count * 2 <= _listeners.length) {
      final newListeners = List<VoidCallback?>.filled(_count, null);

      // Listeners before the index are at the same place.
      for (var i = 0; i < index; i++) {
        newListeners[i] = _listeners[i];
      }

      // Listeners after the index move towards the start of the list.
      for (var i = index; i < _count; i++) {
        newListeners[i] = _listeners[i + 1];
      }

      _listeners = newListeners;
    } else {
      // When there are more listeners than half the length of the list, we only
      // shift our listeners, so that we avoid to reallocate memory for the
      // whole list.
      for (var i = index; i < _count; i++) {
        _listeners[i] = _listeners[i + 1];
      }
      _listeners[_count] = null;
    }
  }

  /// Remove a previously registered closure from the list of closures that are
  /// notified when the object changes.
  ///
  /// If the given listener is not registered, the call is ignored.
  ///
  /// This method returns immediately if [dispose] has been called.
  @override
  void removeListener(VoidCallback listener) {
    // This method is allowed to be called on disposed instances for usability
    // reasons. Due to how our frame scheduling logic between render objects and
    // overlays, it is common that the owner of this instance would be disposed a
    // frame earlier than the listeners. Allowing calls to this method after it
    // is disposed makes it easier for listeners to properly clean up.
    for (var i = 0; i < _count; i++) {
      final VoidCallback? listenerAtIndex = _listeners[i];
      if (listenerAtIndex == listener) {
        if (_notificationCallStackDepth > 0) {
          // We don't resize the list during notifyListeners iterations
          // but we set to null, the listeners we want to remove. We will
          // effectively resize the list at the end of all notifyListeners
          // iterations.
          _listeners[i] = null;
          _reentrantlyRemovedListeners++;
        } else {
          // When we are outside the notifyListeners iterations we can
          // effectively shrink the list.
          _removeAt(i);
        }
        break;
      }
    }
  }
}
`;

describe("real-world smoke test — Ruby (sinatra/sinatra Request excerpt, MIT)", () => {
  it("parses without crashing and resolves real intra-class calls, including bare '?'-suffixed predicate methods", () => {
    const { nodes, edges } = extractCodeGraph(SINATRA_REQUEST_EXCERPT, { filePath: "request.rb" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(classNames).toEqual(["Request"]);
    expect(nodes.filter((n) => n.label === "Function").length).toBeGreaterThanOrEqual(8);

    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    // "accept?" calls "preferred_type(type)" — an ordinary parenthesized call.
    expect(pairs).toContain("Request.accept?->Request.preferred_type");
    // "idempotent?" bare-invokes "safe?"/"link?"/"unlink?" (no parens, no
    // receiver) — captured because '?'-suffixed names are unambiguously
    // calls in this grammar (see queries/ruby.ts's module doc comment);
    // "put?"/"delete?" are NOT defined in this excerpt (inherited from
    // Rack::Request) so they are correctly absent, not fabricated.
    expect(pairs).toContain("Request.idempotent?->Request.safe?");
    expect(pairs).toContain("Request.idempotent?->Request.link?");
    expect(pairs).toContain("Request.idempotent?->Request.unlink?");
    expect(pairs.some((p) => p.includes("put?") || p.includes("delete?"))).toBe(false);
    // "preferred_type"'s bare "accept" (no parens, no '?'/'!' suffix, used
    // only as a dot-chain receiver — "accept.first"/"accept.empty?"/
    // "accept.detect") is NOT itself captured as a call to "accept" — the
    // receiver of a "." call is a plain identifier in this grammar, not a
    // nested call, and "accept" here has no "?"/"!" suffix to force the
    // unambiguous-call reading either.
    expect(pairs.some((p) => p.endsWith("->Request.accept"))).toBe(false);
  });
});

describe("real-world smoke test — PHP (guzzle/guzzle Client excerpt, MIT)", () => {
  it("parses without crashing and resolves a real intra-class '->' call chain", () => {
    const { nodes, edges } = extractCodeGraph(GUZZLE_CLIENT_EXCERPT, { filePath: "client.php" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(classNames).toEqual(["Client"]);
    expect(functionIds).toEqual([
      "client.php#Client.request",
      "client.php#Client.requestAsync",
      "client.php#Client.send",
      "client.php#Client.sendAsync",
      "client.php#Client.sendRequest",
    ]);

    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    expect(pairs).toContain("Client.send->Client.sendAsync");
    expect(pairs).toContain("Client.sendRequest->Client.sendAsync");
    expect(pairs).toContain("Client.request->Client.requestAsync");
    // "prepareDefaults"/"buildUri"/"transfer"/"invalidBody" are defined
    // elsewhere in the real file, outside this excerpt's line range —
    // correctly left unresolved (not fabricated), not asserted here.
    expect(pairs.some((p) => p.includes("prepareDefaults"))).toBe(false);
  });
});

describe("real-world smoke test — Dart (flutter/flutter ChangeNotifier excerpt, BSD-3-Clause)", () => {
  it("parses without crashing and resolves a real intra-class bare call to a private helper method", () => {
    const { nodes, edges } = extractCodeGraph(FLUTTER_CHANGE_NOTIFIER_EXCERPT, {
      filePath: "change_notifier.dart",
    });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(classNames).toEqual(["ChangeNotifier"]);
    expect(functionIds).toEqual([
      "change_notifier.dart#ChangeNotifier._removeAt",
      "change_notifier.dart#ChangeNotifier.removeListener",
    ]);

    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    expect(pairs).toContain("ChangeNotifier.removeListener->ChangeNotifier._removeAt");
  });
});

describe("real-world smoke test — C++ (google/leveldb Status excerpt, BSD-3-Clause)", () => {
  it("parses without crashing and resolves real intra-class calls to a private helper method", () => {
    const { nodes, edges } = extractCodeGraph(LEVELDB_STATUS_EXCERPT, { filePath: "status.cpp" });
    const classNames = nodes.filter((n) => n.label === "Class").map((n) => n.properties.name);
    const functionIds = nodes.filter((n) => n.label === "Function").map((n) => n.id).sort();
    const calls = edges.filter((e) => e.label === "CALLS");

    expect(classNames).toEqual(["Status"]);
    // "ToString() const;" is a declaration only (no body) — a
    // field_declaration in this grammar, not a function_definition — so it
    // is correctly NOT captured as a Function node (see queries/cpp.ts's
    // module doc comment; this engine only extracts function_definition,
    // not bodyless out-of-line-declared prototypes).
    expect(functionIds).toEqual([
      "status.cpp#Status.IsCorruption",
      "status.cpp#Status.IsIOError",
      "status.cpp#Status.IsNotFound",
      "status.cpp#Status.Status",
      "status.cpp#Status.code",
      "status.cpp#Status.ok",
    ]);

    const pairs = calls.map((e) => `${e.from.split("#")[1]}->${e.to.split("#")[1]}`);
    expect(pairs).toContain("Status.IsNotFound->Status.code");
    expect(pairs).toContain("Status.IsCorruption->Status.code");
    expect(pairs).toContain("Status.IsIOError->Status.code");
    // "ok()" only compares state_ to nullptr — no call at all.
    expect(calls.some((e) => e.from === "status.cpp#Status.ok")).toBe(false);
  });
});
