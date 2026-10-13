// SPDX-License-Identifier: MIT
// implements XSPEC-481
/**
 * Names of functions that belong to a language or its standard library, kept in
 * ONE place (XSPEC-481 R1).
 *
 * ## What this list is for, and what it is not for
 *
 * `egr refs check` calls a reference `missing` only when it can show the name
 * once was defined in this repository. For a name such as `date`, `count` or
 * `trim` that evidence is easy to find and means nothing: some bundle, some
 * vendored library, some other language's file has a line shaped like a
 * definition of it. The citation `PHP json_encode/date()` is about PHP, not
 * about a function of this repository, and the beta.4 report had `date()` come
 * back `missing` and fail a CI step because a front-end bundle contained
 * `date:function(t){…}`.
 *
 * So, when the graph holds NO function or class of that name, a reference to one
 * of these names is `unresolvable` ("cannot tell") instead of looking for
 * evidence in history. When the graph DOES hold a definition (the project
 * defines its own `count`), the graph answers first and this list is never
 * consulted.
 *
 * **The price, stated here so it is not discovered later:** a repository
 * function that really was deleted and happened to share a name with one of
 * these is reported `unresolvable`, not `missing`. That is a missed finding,
 * accepted on purpose — a false `missing` is worse than a missed one, because
 * since beta.4 `missing` fails the exit status. Keep this list to names that are
 * unmistakably the language's or library's own; do not add a name only because a
 * project of yours defines it.
 *
 * Method names that projects very commonly give to their own functions — `get`,
 * `add`, `remove`, `update`, `find`, `parse`, `Select`, `Count`, `Add`, `Where`, a
 * list's `append`, and so on — are left out on purpose, for the reason above: each
 * one widens the window in which a really deleted function is reported
 * `unresolvable`. What is listed is the language's global functions (all of PHP's
 * and Python's builtins named here, JavaScript's globals) and the method names that
 * are distinctively the library's (`forEach`, `toLowerCase`, `ToString`,
 * `FirstOrDefault`).
 *
 * Matching is by exact name, case-sensitive (`Parse` is C#, `parse` is not
 * listed). The lists are what documents actually cite when they say "PHP's
 * `date()`", "Python's `len()`", "`.map()`" — not an inventory of any standard
 * library.
 */

export type BuiltinLanguage = "PHP" | "JavaScript" | "C#" | "Python";

const words = (s: string): readonly string[] => s.split(/\s+/).filter(Boolean);

export const BUILTIN_FUNCTIONS: Readonly<Record<BuiltinLanguage, ReadonlySet<string>>> = {
  PHP: new Set(
    words(`
      date time mktime strtotime checkdate microtime sleep usleep
      count sizeof strlen strpos stripos strrpos substr substr_count trim ltrim rtrim
      explode implode join str_replace str_pad str_repeat str_split strtolower strtoupper ucfirst ucwords
      sprintf printf vsprintf number_format nl2br htmlspecialchars htmlentities addslashes stripslashes
      in_array array_map array_filter array_reduce array_merge array_keys array_values array_key_exists
      array_slice array_splice array_push array_pop array_shift array_unshift array_unique array_reverse
      array_search array_sum array_column array_combine array_flip array_diff array_intersect
      sort rsort usort uasort uksort ksort krsort asort arsort range compact extract
      json_encode json_decode serialize unserialize var_export var_dump print_r
      isset empty unset intval floatval strval boolval settype gettype
      is_array is_string is_int is_numeric is_null is_bool is_object is_callable
      file_get_contents file_put_contents fopen fclose fgets fwrite fread file_exists is_file is_dir mkdir unlink
      basename dirname pathinfo realpath tempnam
      preg_match preg_match_all preg_replace preg_replace_callback preg_split
      md5 sha1 crc32 hash base64_encode base64_decode urlencode urldecode rawurlencode http_build_query
      rand mt_rand random_int uniqid min max abs round floor ceil sqrt pow intdiv
      define defined constant function_exists class_exists method_exists property_exists
      header setcookie session_start session_destroy error_log trigger_error
      mb_strlen mb_substr mb_strtolower mb_strtoupper mb_strpos iconv
    `),
  ),
  JavaScript: new Set(
    words(`
      parseInt parseFloat isNaN isFinite
      setTimeout setInterval clearTimeout clearInterval requestAnimationFrame queueMicrotask structuredClone
      encodeURIComponent decodeURIComponent encodeURI decodeURI escape unescape btoa atob
      alert confirm prompt eval require
      forEach reduce reduceRight flatMap indexOf lastIndexOf includes
      splice unshift substring substr startsWith endsWith padStart padEnd trimStart trimEnd replaceAll
      charAt charCodeAt toLowerCase toUpperCase toString toFixed toLocaleString valueOf
    `),
  ),
  "C#": new Set(
    words(`
      ToString Equals GetHashCode GetType ReferenceEquals Dispose
      Parse TryParse
      ToList ToArray ToDictionary SelectMany FirstOrDefault LastOrDefault SingleOrDefault
      OrderBy OrderByDescending ThenBy GroupBy
      Substring Split Trim TrimStart TrimEnd Replace ToUpper ToLower StartsWith EndsWith PadLeft PadRight
      IsNullOrEmpty IsNullOrWhiteSpace
      WriteLine ReadLine
      ConfigureAwait GetAwaiter
    `),
  ),
  Python: new Set(
    words(`
      len print range str int float bool list dict set tuple bytes open input
      isinstance issubclass type id hash iter next callable getattr setattr hasattr delattr super
      enumerate zip map filter sorted reversed sum min max abs round any all pow divmod
      repr format ord chr hex bin oct dir vars globals locals exec eval
    `),
  ),
};

/** The languages whose built-in function lists contain `name`, in a fixed order; empty when none does. */
export function builtinLanguagesFor(name: string): BuiltinLanguage[] {
  return (Object.keys(BUILTIN_FUNCTIONS) as BuiltinLanguage[]).filter((lang) => BUILTIN_FUNCTIONS[lang].has(name));
}
