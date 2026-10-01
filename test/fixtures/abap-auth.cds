// Test-only: the stand-alone ABAP mock asks for a login, like the real service binding does.
using { ZFR_REBOOK } from '../../srv/external/ZFR_REBOOK';
annotate ZFR_REBOOK with @requires: 'authenticated-user';
