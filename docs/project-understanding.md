# What this project is for

The user's main task right now is to find work. `job-search-pipeline` is not an end in itself but a personal working tool of one QA automation engineer: it is already in use in that search and is being improved at the same time. The user does not want to send applications in bulk, but to discard unsuitable vacancies quickly, to see the risks in work format, visa, relocation, time zone, compensation, seniority and automation share up front, and, for promising roles, to get a targeted CV and cover letter ready to send.

The system has to extract the full vacancy description, research the company, match its requirements against confirmed experience, record the positioning decisions and produce the application materials. Those materials must show an engineer who builds durable quality systems, use relevant ATS terms and real metrics, and neither overstate experience nor hide gaps.

The agent must weigh every change to the project from two sides: the quick practical result now, and the quality of running it afterwards. Four questions do that:

- How do we get the result more simply and faster?
- How soon can the user start applying the feature?
- How convenient will it be to use regularly?
- What has to be rebuilt if the feature needs to scale?

Steps are started explicitly; results are validated, saved to files, survive a change of session and are never overwritten silently.
