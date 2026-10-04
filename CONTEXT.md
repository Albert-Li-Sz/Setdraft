# Setdraft domain

Setdraft is a programming contest authoring workspace. Authors edit statements, programs and test data, verify them locally, and publish judge packages.

| Term | Meaning |
| --- | --- |
| Problem type | Standard, special, interactive or communication. Independent of ACM/OI scoring. |
| Standard problem | Executes a solution and compares text with the primary solution's answer. |
| Special problem | Uses a custom Checker to judge a solution's final output. |
| Interactive problem | Runs a contestant and an Interactor in one dialogue. Input may be private or strictly empty. |
| Communication problem | Starts the same contestant program twice. A communication judge validates round one and explicitly hands information to round two. |
| Communication judge | One judge program with two round branches. Private input and handoff belong to the judge, never to the contestant filesystem. |
| Primary solution | The unique required, fully accepted program used to produce answers. |
| Required solution | Its completed result must meet its declared expectation before publication. |
| Observation solution | Its result informs the author without blocking publication. |
| Protocol sample | An ordered, public example of messages. It is documentation, not a private test point. |
| Verification matrix | Test points crossed with solutions, with verdicts, resources and expectation results. |
