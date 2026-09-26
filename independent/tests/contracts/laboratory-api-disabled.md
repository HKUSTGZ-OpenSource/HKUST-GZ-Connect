Production builds do not expose compatibility research APIs. Each negative example
is separate so one missing module cannot conceal another accidentally public module.

```compile_fail
use ec_compat::adapter as _;
```

```compile_fail
use ec_compat::binary_watch as _;
```

```compile_fail
use ec_compat::probe as _;
```

```compile_fail
use ec_compat::protocol_map as _;
```

```compile_fail
use ec_compat::watch as _;
```
